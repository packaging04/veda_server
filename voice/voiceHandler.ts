/**
 * Voice Callback Handler - Enhanced with debugging
 */

import { ENV } from "../config/env.ts";
import { activeSessions, processedCallbacks } from "./sessionStore.ts";
import {
  fetchCallDetails,
  updateCallStatus,
  logEvent,
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { sanitizePhoneNumber, hashPii } from "../security/helpers.ts";
import { AfricasTalkingAction } from "../types/voice.ts";

export async function handleVoiceCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    console.log("📞 CALLBACK HIT", new Date().toISOString());

    const formData = await req.formData();
    const url = new URL(req.url);

    // Log all incoming data for debugging
    console.log(`🔍 [${correlationId}] URL:`, url.toString());
    console.log(
      `🔍 [${correlationId}] Query params:`,
      Object.fromEntries(url.searchParams),
    );
    console.log(
      `🔍 [${correlationId}] Form data:`,
      Object.fromEntries(formData),
    );

    const sessionId = formData.get("sessionId") as string;
    const isActive = formData.get("isActive") as string;

    if (!sessionId) {
      console.error(`❌ [${correlationId}] Missing sessionId in form data`);
      return errorResponse("Missing session");
    }

    // Handle call end
    if (isActive === "0") {
      console.log(`📴 [${correlationId}] Call ended: ${sessionId}`);
      const session = activeSessions.get(sessionId);
      if (session) {
        await updateCallStatus(
          session.scheduledCallId,
          "completed",
          sessionId,
          correlationId,
        );
        await logEvent(
          session.scheduledCallId,
          "call_ended",
          {},
          correlationId,
        );
        activeSessions.delete(sessionId);
      }
      return new Response("", { status: 200 });
    }

    const scheduledCallId = url.searchParams.get("scheduledCallId");

    if (!scheduledCallId) {
      console.error(`❌ [${correlationId}] Missing scheduledCallId in URL`);
      console.error(
        `❌ [${correlationId}] This means the call was not initiated with the scheduledCallId parameter`,
      );
      console.error(
        `❌ [${correlationId}] Check your makeCall function in processor.ts`,
      );
      return errorResponse("Invalid call - missing identifier");
    }

    // IDEMPOTENCY CHECK
    const idempotencyKey = `voice-${sessionId}-${isActive}-${scheduledCallId}`;
    if (processedCallbacks.has(idempotencyKey)) {
      console.log(`⚠️  [${correlationId}] Duplicate callback ignored`);
      return new Response(buildVoiceXML([]), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    processedCallbacks.add(idempotencyKey);
    setTimeout(() => processedCallbacks.delete(idempotencyKey), 5 * 60 * 1000);

    let session = activeSessions.get(sessionId);

    if (!session) {
      console.log(`✨ [${correlationId}] New session - fetching call details`);

      const callDetails = await fetchCallDetails(
        scheduledCallId,
        correlationId,
      );

      if (!callDetails) {
        console.error(
          `❌ [${correlationId}] Call not found in database: ${scheduledCallId}`,
        );
        return errorResponse("Call not found");
      }

      console.log(
        `✅ [${correlationId}] Call details found for ${hashPii(callDetails.lovedOneName)}`,
      );

      session = {
        sessionId,
        scheduledCallId,
        userId: callDetails.userId,
        lovedOneId: callDetails.lovedOneId,
        lovedOneName: callDetails.lovedOneName,
        phoneNumber: sanitizePhoneNumber(callDetails.phoneNumber),
        currentQuestionIndex: 0,
        questions: callDetails.questions,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };

      activeSessions.set(sessionId, session);

      await updateCallStatus(
        scheduledCallId,
        "in_progress",
        sessionId,
        correlationId,
      );
      await logEvent(
        scheduledCallId,
        "call_started",
        {
          loved_one_name: callDetails.lovedOneName,
          total_questions: session.questions.length,
        },
        correlationId,
      );

      console.log(
        `📞 [${correlationId}] Session created for ${hashPii(callDetails.lovedOneName)} with ${session.questions.length} questions`,
      );
    } else {
      session.lastActivity = new Date().toISOString();
      console.log(`🔄 [${correlationId}] Existing session updated`);
    }

    const actions: AfricasTalkingAction[] = [];

    // Greeting
    if (session.currentQuestionIndex === 0) {
      console.log(`👋 [${correlationId}] Sending greeting`);

      actions.push({
        say: {
          text: `Hello ${session.lovedOneName}. This is Veda, calling to help preserve your precious memories for your family. This call will be recorded. Are you ready to share your stories?`,
          voice: "female",
          playBeep: false,
        },
      });

      actions.push({ pause: { length: 2 } });

      actions.push({
        say: {
          text: "Let's begin.",
          voice: "female",
          playBeep: false,
        },
      });

      actions.push({ pause: { length: 1 } });
    }

    // Ask current question
    if (session.currentQuestionIndex < session.questions.length) {
      const currentQ = session.questions[session.currentQuestionIndex];

      console.log(
        `❓ [${correlationId}] Asking Q${session.currentQuestionIndex + 1}/${session.questions.length}: ${currentQ.text.substring(0, 50)}...`,
      );

      actions.push({
        say: {
          text: currentQ.text,
          voice: "female",
          playBeep: false,
        },
      });

      actions.push({ pause: { length: 1 } });

      const callbackUrl = `${ENV.BASE_URL}/recording?sessionId=${sessionId}&scheduledCallId=${scheduledCallId}&questionIndex=${session.currentQuestionIndex}&questionId=${currentQ.id}`;

      actions.push({
        record: {
          maxLength: 180,
          timeout: 5,
          finishOnKey: "#",
          trimSilence: true,
          playBeep: true,
          callbackUrl,
        },
      });

      await logEvent(
        scheduledCallId,
        "question_asked",
        {
          question_index: session.currentQuestionIndex,
          question_id: currentQ.id,
        },
        correlationId,
      );
    } else {
      console.log(`✅ [${correlationId}] All questions completed`);

      actions.push({
        say: {
          text: `Thank you so much for sharing these beautiful memories, ${session.lovedOneName}. Your stories will be treasured for generations. Goodbye.`,
          voice: "female",
          playBeep: false,
        },
      });

      await updateCallStatus(
        session.scheduledCallId,
        "completed",
        sessionId,
        correlationId,
      );

      setTimeout(() => activeSessions.delete(sessionId), 10000);
    }

    const xmlResponse = buildVoiceXML(actions);
    console.log(
      `📤 [${correlationId}] Sending XML response (${xmlResponse.length} chars)`,
    );

    return new Response(xmlResponse, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Voice error:`, error);
    // console.error(`❌ [${correlationId}] Stack:`, error.stack);
    return errorResponse("Technical difficulty");
  }
}

function errorResponse(message: string): Response {
  console.log(`⚠️  Sending error response: ${message}`);
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: `I apologize, but we're experiencing ${message}. Please try again later. Goodbye.`,
          voice: "female",
        },
      },
    ]),
    {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    },
  );
}