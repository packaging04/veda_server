import { ENV } from "../config/env.ts";
import { activeSessions, processedCallbacks } from "./sessionStore.ts";
import {
  lookupUserByPhone,
  createInboundSession,
  updateInboundSessionStatus,
  logEvent,
  getUserQuestionProgress,
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { sanitizePhoneNumber } from "../security/helpers.ts";
import { AfricasTalkingAction, InboundSession } from "../types/voice.ts";
import { deliverGreetingAndFirstQuestion } from "./converseHandler.ts";

export async function handleVoiceCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    console.log(`📞 [${correlationId}] Inbound call`);

    const sessionId = formData.get("sessionId") as string;
    const isActive = formData.get("isActive") as string;
    const callerNumber = sanitizePhoneNumber(
      (formData.get("callerNumber") as string) || "",
    );

    if (!sessionId) return errorResponse("Session error");

    // ── Call ended ────────────────────────────────────────────────────────────
    if (isActive === "0") {
      const session = activeSessions.get(sessionId);
      if (session) {
        await updateInboundSessionStatus(
          sessionId,
          "completed",
          session.sessionQuestionsAsked.length,
          correlationId,
        );
        await logEvent(
          sessionId,
          "call_ended",
          {
            turns: session.conversationHistory.length,
            session_questions: session.sessionQuestionsAsked.length,
            global_questions: session.globalQuestionsAsked.length,
          },
          correlationId,
        );
        activeSessions.delete(sessionId);
      }
      return new Response("", { status: 200 });
    }

    // ── Idempotency ───────────────────────────────────────────────────────────
    const idempotencyKey = `voice-${sessionId}-${isActive}`;
    if (processedCallbacks.has(idempotencyKey)) {
      return new Response(buildVoiceXML([]), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    processedCallbacks.add(idempotencyKey);
    setTimeout(() => processedCallbacks.delete(idempotencyKey), 5 * 60 * 1000);

    let session = activeSessions.get(sessionId);

    // ── New session ───────────────────────────────────────────────────────────
    if (!session) {
      const profileByPhone = callerNumber
        ? await lookupUserByPhone(callerNumber, correlationId)
        : null;

      // Load global question history if we identified the user
      const globalQuestionsAsked = profileByPhone
        ? await getUserQuestionProgress(profileByPhone.userId, correlationId)
        : [];

      session = {
        sessionId,
        userId: profileByPhone?.userId || "",
        userProfile: profileByPhone,
        callerPhone: callerNumber,
        phase: profileByPhone ? "greeting" : "identifying",
        conversationHistory: [],
        sessionQuestionsAsked: [],
        globalQuestionsAsked,
        currentQuestionId: null,
        followUpCount: 0,
        pendingRecordingUrl: null,
        pendingTurnIndex: 0,
        pendingQuestionId: "",
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        identifiedViaPhone: !!profileByPhone,
      };

      activeSessions.set(sessionId, session);

      if (profileByPhone) {
        // Get session count for this user
        const sessionNumber = await getUserSessionCount(
          profileByPhone.userId,
          correlationId,
        );

        await createInboundSession(
          sessionId,
          profileByPhone.userId,
          callerNumber,
          true,
          sessionNumber,
          correlationId,
        );
        await logEvent(
          sessionId,
          "call_started_identified",
          {
            method: "phone_window",
            user_type: profileByPhone.userType,
            past_questions: globalQuestionsAsked.length,
            session_number: sessionNumber,
          },
          correlationId,
        );
      } else {
        await logEvent(
          sessionId,
          "call_started_unknown",
          {
            caller_phone: callerNumber,
          },
          correlationId,
        );
      }
    } else {
      session.lastActivity = new Date().toISOString();
      activeSessions.set(sessionId, session);
    }

    // ── Route to correct phase ────────────────────────────────────────────────
    if (session.phase === "identifying") {
      return handleIdentificationPhase(session, sessionId);
    }

    if (session.phase === "greeting") {
      return await handleGreetingPhase(session, sessionId, correlationId);
    }

    return new Response(buildVoiceXML([]), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Voice handler error:`, error);
    return errorResponse("technical difficulty");
  }
}

function handleIdentificationPhase(
  session: InboundSession,
  sessionId: string,
): Response {
  const isReturning = false; // could detect based on known phone

  const actions: AfricasTalkingAction[] = [
    {
      say: {
        text: "Hello, and welcome to Veda. I'm so glad you called. To get started, could you please say your personal access code? You would have received it when you registered. Please say it clearly after the beep.",
        voice: "woman",
        playBeep: false,
      },
    },
    { pause: { length: 1 } },
    {
      record: {
        maxLength: 15,
        timeout: 8,
        finishOnKey: "#",
        trimSilence: true,
        playBeep: true,
        callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=identification`,
      },
    },
  ];

  return new Response(buildVoiceXML(actions), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

async function handleGreetingPhase(
  session: InboundSession,
  sessionId: string,
  correlationId: string,
): Promise<Response> {
  // Delegate to conversationHandler which handles greeting + first question + Record
  return await deliverGreetingAndFirstQuestion(
    session,
    sessionId,
    correlationId,
  );
}

async function getUserSessionCount(
  userId: string,
  correlationId: string,
): Promise<number> {
  try {
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_sessions?user_id=eq.${userId}&select=id`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!response.ok) return 1;
    const rows = await response.json();
    return rows.length + 1;
  } catch {
    return 1;
  }
}

function errorResponse(message: string): Response {
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: "I'm sorry, we're experiencing a technical issue. Please try calling back shortly. Goodbye.",
          voice: "woman",
        },
      },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
