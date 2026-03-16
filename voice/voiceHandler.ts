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
  uploadToSupabaseStorage,
  getUserIdBySessionId,
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
        // Session not in memory (isolate restart) — reconstruct userId from DB
        // and run the full recording pipeline so nothing is lost
        console.warn(
          `⚠️  [${correlationId}] Session ${sessionId} not in memory at call end`,
        );
        if (recordingUrl) {
          const userId = await getUserIdBySessionId(sessionId, correlationId);
          if (userId) {
            console.log(
              `🔄 [${correlationId}] Recovered userId=${userId} for orphaned session — processing recording`,
            );
            processOrphanedRecording(
              recordingUrl,
              durationInSeconds,
              sessionId,
              userId,
              correlationId,
            ).catch((e) =>
              console.error(
                `❌ [${correlationId}] Orphaned recording error:`,
                e,
              ),
            );
          } else {
            // Can't recover userId — log to call_logs as last resort
            console.warn(
              `⚠️  [${correlationId}] Could not recover userId — logging orphaned recording`,
            );
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

    // Upload to Supabase Storage immediately — AT URLs are temporary
    const permanentUrl = await uploadToSupabaseStorage(
      audioBuffer,
      session.userId,
      sessionId,
      correlationId,
      recordingUrl, // AT URL as fallback
    );

    // Transcribe with retry on 429 rate limit
    let transcript = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        transcript = await transcribeAudio(audioBuffer, correlationId);
        break;
      } catch (err: any) {
        if (err?.message?.includes("429") && attempt < 3) {
          const wait = attempt * 5000;
          console.warn(
            `⚠️  [${correlationId}] Whisper 429 — retrying in ${wait / 1000}s (attempt ${attempt}/3)`,
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          console.error(
            `❌ [${correlationId}] Whisper failed after ${attempt} attempts:`,
            err,
          );
          break;
        }
      }
    }
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
        audioUrl: permanentUrl,
      },
      correlationId,
    );

    // Save recording record with permanent Supabase URL
    await saveRecording(
      sessionId,
      session.userId,
      questionId,
      `Question ${session.sessionQuestionsAsked.length}`,
      session.sessionQuestionsAsked.length,
      permanentUrl,
      "",
      durationSeconds,
      audioBuffer.byteLength,
      correlationId,
      transcript,
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
  // Use <GetDigits> NOT <Record> — DTMF keypad input is instant and reliable.
  // No audio file, no Whisper transcription, no 15s timeout risk.
  // User types their 6-digit PIN → AT sends dtmfDigits to /code immediately.
  const actions: AfricasTalkingAction[] = [
    {
      getDigits: {
        timeout: 15,
        numDigits: 6,
        finishOnKey: "#",
        callbackUrl: `${ENV.BASE_URL}/code?sessionId=${sessionId}`,
        promptText:
          "Hello, and welcome to Veda. I'm so glad you called. To get started, please enter your 6-digit PIN on your keypad, then press hash. You'll find your PIN in the Veda app.",
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

// ─── Orphaned recording pipeline ─────────────────────────────────────────────
// Runs when session isn't in memory (Deno isolate restart).
// Recovers userId from DB, downloads audio, uploads to Storage, saves row.

async function processOrphanedRecording(
  atRecordingUrl: string,
  durationSeconds: number,
  sessionId: string,
  userId: string,
  correlationId: string,
): Promise<void> {
  console.log(
    `📼 [${correlationId}] Processing orphaned recording — session ${sessionId}`,
  );
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const audioResp = await fetch(atRecordingUrl, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!audioResp.ok) {
      console.error(
        `❌ [${correlationId}] Orphaned download failed: ${audioResp.status}`,
      );
      return;
    }

    const audioBuffer = await audioResp.arrayBuffer();
    console.log(
      `✅ [${correlationId}] Orphaned download: ${(audioBuffer.byteLength / 1024).toFixed(1)}KB`,
    );

    // Upload to permanent storage
    const permanentUrl = await uploadToSupabaseStorage(
      audioBuffer,
      userId,
      sessionId,
      correlationId,
      atRecordingUrl,
    );

    // Transcribe with retry on 429
    let transcript = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        transcript = await transcribeAudio(audioBuffer, correlationId);
        break;
      } catch (err: any) {
        if (err?.message?.includes("429") && attempt < 3) {
          const wait = attempt * 5000;
          console.warn(
            `⚠️  [${correlationId}] Whisper 429 — retrying in ${wait / 1000}s (attempt ${attempt}/3)`,
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          console.error(
            `❌ [${correlationId}] Whisper failed after ${attempt} attempts:`,
            err,
          );
          break;
        }
      }
    }

    // Save recording row — even without transcript
    await saveRecording(
      sessionId,
      userId,
      "orphaned",
      "Wisdom Session",
      0,
      permanentUrl,
      "",
      durationSeconds,
      audioBuffer.byteLength,
      correlationId,
      transcript || undefined,
    );

    console.log(
      `✅ [${correlationId}] Orphaned recording saved — url: ${permanentUrl.substring(0, 60)}...`,
    );
  } catch (err) {
    console.error(`❌ [${correlationId}] processOrphanedRecording error:`, err);
  }
}
