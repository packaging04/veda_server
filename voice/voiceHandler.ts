import { ENV } from "../config/env.ts";
import { activeSessions, processedCallbacks } from "./sessionStore.ts";
import {
  lookupUserByPhone,
  createInboundSession,
  updateInboundSessionStatus,
  logEvent,
  getUserQuestionProgress,
  saveConversationTurn,
  saveRecording,
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { sanitizePhoneNumber } from "../security/helpers.ts";
import { deliverGreetingAndFirstQuestion } from "./aiThinkingHandler.ts";
import { transcribeAudio } from "../background/transcription.ts";
import { AfricasTalkingAction, InboundSession } from "../types/voice.ts";

export async function handleVoiceCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();

    // Log all fields AT sends — critical for debugging
    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) fields[k] = v.toString();
    console.log(`📞 [${correlationId}] /voice fields:`, JSON.stringify(fields));

    const sessionId = formData.get("sessionId") as string;
    const isActive = formData.get("isActive") as string;
    const callerNumber = sanitizePhoneNumber(
      (formData.get("callerNumber") as string) || "",
    );

    if (!sessionId) return errorResponse("Session error");

    // ── Call ended (isActive=0) ───────────────────────────────────────────────
    // AT sends this when the call completes. It includes recordingUrl if the
    // user was recording when they hung up. We save + process it here so no
    // response is ever lost, even if /recording callback was never triggered.
    if (isActive === "0") {
      const recordingUrl = formData.get("recordingUrl") as string | null;
      const durationInSeconds = parseInt(
        (formData.get("durationInSeconds") as string) || "0",
      );
      const session = activeSessions.get(sessionId);

      console.log(
        `📞 [${correlationId}] Call ended. duration=${durationInSeconds}s, recordingUrl=${recordingUrl ? "PRESENT" : "none"}`,
      );

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
            duration_seconds: durationInSeconds,
            turns: session.conversationHistory.length,
            session_questions: session.sessionQuestionsAsked.length,
            global_questions: session.globalQuestionsAsked.length,
            had_recording: !!recordingUrl,
          },
          correlationId,
        );

        // ── Save + transcribe recording from completion event (background) ──
        // This catches responses that arrived ONLY in the completion event,
        // e.g. user hung up before the 3s silence timeout fired.
        if (recordingUrl && session.currentQuestionId) {
          processCallCompletionRecording(
            recordingUrl,
            durationInSeconds,
            session,
            sessionId,
            correlationId,
          ).catch((e) =>
            console.error(
              `❌ [${correlationId}] Completion recording error:`,
              e,
            ),
          );
        }

        activeSessions.delete(sessionId);
      } else {
        // Session not in memory (e.g. isolate restart) — still log it
        console.warn(
          `⚠️  [${correlationId}] Session ${sessionId} not in memory at call end`,
        );
        if (recordingUrl) {
          console.log(
            `📼 [${correlationId}] Recording URL (no session): ${recordingUrl}`,
          );
          // Save a minimal record so we don't lose it
          await logEvent(
            sessionId,
            "orphaned_recording",
            {
              recording_url: recordingUrl,
              duration_seconds: durationInSeconds,
              caller: callerNumber,
            },
            correlationId,
          );
        }
      }

      return new Response("", { status: 200 });
    }

    // ── Idempotency (active call) ─────────────────────────────────────────────
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
          { caller_phone: callerNumber },
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
      return await deliverGreetingAndFirstQuestion(
        session,
        sessionId,
        correlationId,
      );
    }

    // Already in conversation — AT called /voice again unexpectedly
    // Just return empty to keep the call alive
    console.warn(
      `⚠️  [${correlationId}] Unexpected /voice call in phase: ${session.phase}`,
    );
    return new Response(buildVoiceXML([]), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Voice handler error:`, error);
    return errorResponse("technical difficulty");
  }
}

// ─── Process recording that arrived in call completion event ──────────────────
// Runs in background after we've already responded to AT (non-blocking)

async function processCallCompletionRecording(
  recordingUrl: string,
  durationSeconds: number,
  session: InboundSession,
  sessionId: string,
  correlationId: string,
): Promise<void> {
  console.log(
    `📼 [${correlationId}] Processing completion recording for session ${sessionId}`,
  );

  try {
    // Download the audio
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      ENV.FETCH_TIMEOUT_MS,
    );
    const audioResp = await fetch(recordingUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!audioResp.ok) {
      console.error(
        `❌ [${correlationId}] Completion recording download failed: ${audioResp.status}`,
      );
      return;
    }

    const audioBuffer = await audioResp.arrayBuffer();
    console.log(
      `✅ [${correlationId}] Completion recording downloaded: ${(audioBuffer.byteLength / 1024).toFixed(1)}KB`,
    );

    // Transcribe
    const transcript = await transcribeAudio(audioBuffer, correlationId);
    console.log(
      `📝 [${correlationId}] Completion transcript: "${transcript.substring(0, 100)}"`,
    );

    if (!transcript.trim()) return;

    const questionId = session.currentQuestionId || "unknown";

    // Save conversation turn
    await saveConversationTurn(
      sessionId,
      session.userId,
      {
        role: "user",
        content: transcript,
        timestamp: new Date().toISOString(),
        questionId,
        audioUrl: recordingUrl,
      },
      correlationId,
    );

    // Save recording record
    await saveRecording(
      sessionId,
      session.userId,
      questionId,
      `Question ${session.sessionQuestionsAsked.length}`,
      session.sessionQuestionsAsked.length,
      recordingUrl,
      "",
      durationSeconds,
      audioBuffer.byteLength,
      correlationId,
    );

    console.log(
      `✅ [${correlationId}] Completion recording saved for session ${sessionId}`,
    );
  } catch (err) {
    console.error(
      `❌ [${correlationId}] processCallCompletionRecording error:`,
      err,
    );
  }
}

// ─── Identification phase (ask for code) ─────────────────────────────────────

function handleIdentificationPhase(
  session: InboundSession,
  sessionId: string,
): Response {
  const actions: AfricasTalkingAction[] = [
    {
      say: {
        text: "Hello, and welcome to Veda. I'm so glad you called. To get started, please say your 6-character access code slowly and clearly, then press the hash key.",
        voice: "woman",
        playBeep: false,
      },
    },
    {
      record: {
        maxLength: 20,
        timeout: 5,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
