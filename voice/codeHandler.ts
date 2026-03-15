/**
 * Code Handler — DTMF PIN verification via <GetDigits>
 *
 * This replaces the old <Record> + Whisper approach for access code entry.
 *
 * Flow:
 *   voiceHandler returns <GetDigits callbackUrl="/code">
 *   User types 6-digit PIN on keypad + presses # (or auto after 6 digits)
 *   AT sends POST to /code with dtmfDigits=382947
 *   We do a DB lookup (< 100ms) and return the greeting XML immediately
 *
 * Why this is better:
 *   Old: Record audio → download → Whisper transcribe → fuzzy match → 15s timeout risk
 *   New: Read dtmfDigits string → exact DB lookup → done in < 500ms
 */

import { ENV } from "../config/env.ts";
import { activeSessions } from "./sessionStore.ts";
import {
  lookupUserByCode,
  createInboundSession,
  getUserQuestionProgress,
  logEvent,
  saveRecording,
  saveConversationTurn,
  uploadToSupabaseStorage,
  updateInboundSessionStatus,
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { deliverGreetingAndFirstQuestion } from "./aiThinkingHandler.ts";
import { AfricasTalkingAction } from "../types/voice.ts";
import { transcribeAudio } from "../background/transcription.ts";

export async function handleCodeCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    // Log all fields
    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) fields[k] = v.toString();
    console.log(`🔢 [${correlationId}] /code fields:`, JSON.stringify(fields));

    const isActive = formData.get("isActive") as string;
    const sessionId =
      url.searchParams.get("sessionId") ||
      (formData.get("sessionId") as string);
    const isRetry = url.searchParams.get("retry") === "1";

    // ── Call completion event ─────────────────────────────────────────────────
    // AT sends the final completion event back to the last URL that responded
    // with XML — which is /code after PIN verification. Handle it here so the
    // recordingUrl is never silently dropped.
    if (isActive === "0") {
      const recordingUrl = formData.get("recordingUrl") as string | null;
      const durationSeconds = parseInt(
        (formData.get("durationInSeconds") as string) || "0",
      );

      console.log(
        `📞 [${correlationId}] /code completion event — duration=${durationSeconds}s, recordingUrl=${recordingUrl ? "PRESENT" : "none"}`,
      );

      if (recordingUrl && sessionId) {
        const session = activeSessions.get(sessionId);

        // Process in background — respond to AT immediately (no timeout risk)
        processCodeCompletionRecording(
          recordingUrl,
          durationSeconds,
          sessionId,
          session?.userId || "",
          session?.currentQuestionId || null,
          session?.sessionQuestionsAsked?.length || 0,
          correlationId,
        ).catch((e) =>
          console.error(
            `❌ [${correlationId}] Code completion recording error:`,
            e,
          ),
        );

        if (session) {
          await updateInboundSessionStatus(
            sessionId,
            "completed",
            session.sessionQuestionsAsked.length,
            correlationId,
          );
          activeSessions.delete(sessionId);
        }
      } else {
        console.log(`📞 [${correlationId}] /code completion — no recordingUrl`);
      }

      return new Response("", { status: 200 });
    }

    const dtmfDigits = ((formData.get("dtmfDigits") as string) || "").trim();
    console.log(
      `🔢 [${correlationId}] PIN entered: "${dtmfDigits}" for session: ${sessionId}`,
    );

    if (!sessionId) {
      return errorXml("I'm sorry, your session expired. Please call back.");
    }

    if (!dtmfDigits || dtmfDigits.length < 4) {
      console.warn(`⚠️  [${correlationId}] PIN too short: "${dtmfDigits}"`);
      return retryXml(sessionId, isRetry, "I didn't catch that.");
    }

    // ── Instant DB lookup — no audio, no Whisper ────────────────────────────
    const profile = await lookupUserByCode(dtmfDigits, correlationId);

    if (!profile) {
      console.warn(`⚠️  [${correlationId}] Invalid PIN: "${dtmfDigits}"`);

      if (isRetry) {
        // Second failed attempt — end the call gracefully
        return new Response(
          buildVoiceXML([
            {
              say: {
                text: "I wasn't able to verify your PIN after two attempts. Please check the PIN in your app and call back when you're ready. Goodbye.",
                voice: "woman",
                playBeep: false,
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "text/xml" } },
        );
      }

      return retryXml(sessionId, false, "That PIN wasn't recognised.");
    }

    // ── PIN verified ────────────────────────────────────────────────────────
    console.log(`✅ [${correlationId}] PIN verified for: ${profile.name}`);

    // Get or create session
    let session = activeSessions.get(sessionId);

    if (!session) {
      // Session may have expired from memory — reconstruct it
      const globalQuestionsAsked = await getUserQuestionProgress(
        profile.userId,
        correlationId,
      );
      const sessionCount = await getSessionCount(profile.userId, correlationId);

      session = {
        sessionId,
        userId: profile.userId,
        userProfile: profile,
        callerPhone: "",
        phase: "greeting",
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
        identifiedViaPhone: false,
      };

      activeSessions.set(sessionId, session);

      await createInboundSession(
        sessionId,
        profile.userId,
        "",
        false,
        sessionCount,
        correlationId,
      );
    } else {
      session.userProfile = profile;
      session.userId = profile.userId;
      session.globalQuestionsAsked = await getUserQuestionProgress(
        profile.userId,
        correlationId,
      );
      session.phase = "greeting";
      session.identifiedViaPhone = false;
      activeSessions.set(sessionId, session);
    }

    await logEvent(
      sessionId,
      "identity_confirmed",
      {
        method: "dtmf_pin",
        user_type: profile.userType,
        past_questions: session.globalQuestionsAsked.length,
      },
      correlationId,
    );

    // ── Return greeting + first question immediately ─────────────────────────
    return await deliverGreetingAndFirstQuestion(
      session,
      sessionId,
      correlationId,
    );
  } catch (error) {
    console.error(`❌ [${correlationId}] Code handler error:`, error);
    return errorXml("I had a brief technical issue. Please call back.");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function retryXml(
  sessionId: string,
  wasAlreadyRetry: boolean,
  reason: string,
): Response {
  const prompt = wasAlreadyRetry
    ? `${reason} Please try your 6-digit PIN one more time, then press hash.`
    : `${reason} Please enter your 6-digit PIN, then press hash.`;

  const actions: AfricasTalkingAction[] = [
    {
      getDigits: {
        timeout: 15,
        numDigits: 6,
        finishOnKey: "#",
        callbackUrl: `${ENV.BASE_URL}/code?sessionId=${sessionId}&retry=1`,
        promptText: prompt,
      },
    },
  ];

  return new Response(buildVoiceXML(actions), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function errorXml(message: string): Response {
  return new Response(
    buildVoiceXML([
      { say: { text: message, voice: "woman", playBeep: false } },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

async function getSessionCount(
  userId: string,
  correlationId: string,
): Promise<number> {
  try {
    const resp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_sessions?user_id=eq.${userId}&select=id`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!resp.ok) return 1;
    const rows = await resp.json();
    return rows.length + 1;
  } catch {
    return 1;
  }
}

// ─── Background: process recording from call completion event ─────────────────
// Runs non-blocking after we've already returned 200 to AT.
// Same pattern as processCallCompletionRecording in voiceHandler.ts.

async function processCodeCompletionRecording(
  atRecordingUrl: string,
  durationSeconds: number,
  sessionId: string,
  userId: string,
  questionId: string | null,
  turnIndex: number,
  correlationId: string,
): Promise<void> {
  console.log(
    `📼 [${correlationId}] Processing /code completion recording for session ${sessionId}`,
  );

  try {
    // Download from AT's temporary URL
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const audioResp = await fetch(atRecordingUrl, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!audioResp.ok) {
      console.error(
        `❌ [${correlationId}] Recording download failed: ${audioResp.status}`,
      );
      return;
    }

    const audioBuffer = await audioResp.arrayBuffer();
    console.log(
      `✅ [${correlationId}] Downloaded ${(audioBuffer.byteLength / 1024).toFixed(1)}KB`,
    );

    // Upload to Supabase Storage immediately — AT URLs are temporary
    const permanentUrl = await uploadToSupabaseStorage(
      audioBuffer,
      userId,
      sessionId,
      correlationId,
      atRecordingUrl,
    );

    // Transcribe
    const transcript = await transcribeAudio(audioBuffer, correlationId);
    console.log(
      `📝 [${correlationId}] Transcript: "${transcript.substring(0, 120)}"`,
    );

    if (!transcript.trim()) {
      console.log(
        `⚠️  [${correlationId}] Empty transcript — saving recording without text`,
      );
    }

    const qId = questionId || "unknown";

    // Save conversation turn if we have a transcript
    if (transcript.trim() && userId) {
      await saveConversationTurn(
        sessionId,
        userId,
        {
          role: "user",
          content: transcript,
          timestamp: new Date().toISOString(),
          questionId: qId,
          audioUrl: permanentUrl,
        },
        correlationId,
      );
    }

    // Always save the recording row — even without transcript
    if (userId) {
      await saveRecording(
        sessionId,
        userId,
        qId,
        `Session recording (turn ${turnIndex + 1})`,
        turnIndex,
        permanentUrl,
        "",
        durationSeconds,
        audioBuffer.byteLength,
        correlationId,
        transcript || undefined,
      );
    }

    console.log(
      `✅ [${correlationId}] /code completion recording saved — url: ${permanentUrl.substring(0, 60)}...`,
    );
  } catch (err) {
    console.error(
      `❌ [${correlationId}] processCodeCompletionRecording error:`,
      err,
    );
  }
}
