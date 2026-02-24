/**
 * AI Thinking Handler — Step 2 of the latency bridge
 *
 * AT follows the <Redirect> from /recording, giving us a fresh 15-second window.
 * By this point the filler phrase has played (~4s), so audio download has a head start
 * if we fire it immediately.
 *
 * Speed budget:
 *   Download audio from at-internal.com:  2–4s
 *   Whisper transcription:                4–6s
 *   Claude Haiku decision:                1–2s   ← Haiku not Sonnet (3–4x faster)
 *   Supabase saves (non-blocking):        0s (fire-and-forget)
 *   ─────────────────────────────────────────
 *   Total:                                7–12s  ✓ well under 15s
 *
 * AT sends this as POST when following a <Redirect> (not GET).
 * main.ts accepts both GET and POST on /ai_thinking.
 */

import { ENV } from "../config/env.ts";
import { activeSessions } from "./sessionStore.ts";
import {
  updateInboundSessionStatus,
  saveConversationTurn,
  saveQuestionProgress,
  getUserQuestionProgress,
  createInboundSession,
  lookupUserByCode,
  logEvent,
  saveRecording,
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { transcribeAudio } from "../background/transcription.ts";
import {
  getAIDecisionFast,
  getGreeting,
  getFirstQuestion,
} from "./aiConversation.ts";
import {
  AfricasTalkingAction,
  ConversationTurn,
  AIDecision,
  InboundSession,
} from "../types/voice.ts";

export async function handleAIThinking(
  req: Request,
  correlationId: string,
): Promise<Response> {
  const startTime = Date.now();

  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const phase = url.searchParams.get("phase") || "conversation";
    const durationSeconds = parseInt(
      url.searchParams.get("durationSeconds") || "0",
    );
    const recordingUrlParam = url.searchParams.get("recordingUrl");
    const questionIdParam = url.searchParams.get("questionId") || "";
    const turnIndexParam = parseInt(url.searchParams.get("turnIndex") || "0");

    if (!sessionId) return errorResponse();

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found: ${sessionId}`);
      return errorResponse();
    }

    // Get recordingUrl: query param is primary (cross-isolate safe), session is fallback
    const recordingUrl = recordingUrlParam || session.pendingRecordingUrl;
    const turnIndex = turnIndexParam ?? session.pendingTurnIndex;
    const questionId = questionIdParam || session.pendingQuestionId;

    if (!recordingUrl) {
      console.error(`❌ [${correlationId}] No recording URL`);
      return errorResponse();
    }

    console.log(
      `🧠 [${correlationId}] ai_thinking — phase=${phase} turn=${turnIndex} (${Date.now() - startTime}ms since entry)`,
    );

    // Clear pending state
    session.pendingRecordingUrl = null;
    activeSessions.set(sessionId, session);

    // ── Download audio ─────────────────────────────────────────────────────────
    const controller = new AbortController();
    // Keep within 10s to leave room for Whisper + Haiku
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let audioBuffer: ArrayBuffer;

    try {
      console.log(
        `⬇️  [${correlationId}] Downloading: ${recordingUrl.substring(0, 70)}...`,
      );
      const audioResp = await fetch(recordingUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!audioResp.ok) throw new Error(`HTTP ${audioResp.status}`);
      audioBuffer = await audioResp.arrayBuffer();
      console.log(
        `✅ [${correlationId}] Downloaded ${(audioBuffer.byteLength / 1024).toFixed(1)}KB in ${Date.now() - startTime}ms`,
      );
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`❌ [${correlationId}] Download failed:`, err);
      return errorResponse();
    }

    // ── Identification phase ───────────────────────────────────────────────────
    if (phase === "identification" || phase === "identification_retry") {
      return await handleIdentification(
        session,
        sessionId,
        audioBuffer,
        phase,
        correlationId,
      );
    }

    // ── Transcribe ─────────────────────────────────────────────────────────────
    const transcript = await transcribeAudio(audioBuffer, correlationId);
    console.log(
      `📝 [${correlationId}] Transcribed in ${Date.now() - startTime}ms: "${transcript.substring(0, 100)}"`,
    );

    // Empty transcript — re-prompt
    if (!transcript.trim()) {
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "I didn't quite catch that. Please go ahead whenever you're ready.",
              voice: "woman",
              playBeep: false,
            },
          },
          {
            record: {
              maxLength: ENV.RECORDING_MAX_LENGTH_SECONDS,
              timeout: ENV.RECORDING_TIMEOUT_SECONDS,
              finishOnKey: "#",
              trimSilence: true,
              playBeep: false,
              callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=conversation&questionId=${questionId}&turnIndex=${turnIndex}`,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }

    // ── Save user turn (non-blocking) ──────────────────────────────────────────
    const userTurn: ConversationTurn = {
      role: "user",
      content: transcript,
      timestamp: new Date().toISOString(),
      questionId,
      audioUrl: recordingUrl,
    };
    session.conversationHistory.push(userTurn);
    session.lastActivity = new Date().toISOString();
    activeSessions.set(sessionId, session);

    // Fire DB saves in background — don't await in critical path
    saveConversationTurn(
      sessionId,
      session.userId,
      userTurn,
      correlationId,
    ).catch((e) => console.error(`❌ saveConversationTurn error:`, e));
    saveRecording(
      sessionId,
      session.userId,
      questionId,
      `Q${turnIndex + 1}`,
      turnIndex,
      recordingUrl,
      "",
      durationSeconds,
      audioBuffer.byteLength,
      correlationId,
      transcript,
    ).catch((e) => console.error(`❌ saveRecording error:`, e));

    // ── AI decision (Haiku — fast) ─────────────────────────────────────────────
    const sessionQCount = session.sessionQuestionsAsked.length;
    const shouldWrap = sessionQCount >= ENV.QUESTIONS_PER_SESSION;

    let decision: AIDecision;
    if (shouldWrap) {
      decision = buildWrapUp(session);
    } else {
      console.log(`🧠 [${correlationId}] Calling Haiku for decision...`);
      decision = await getAIDecisionFast(session, transcript);
      console.log(
        `🧠 [${correlationId}] Decision in ${Date.now() - startTime}ms: ${decision.action}`,
      );
    }

    // ── Update tracking ────────────────────────────────────────────────────────
    if (decision.action === "follow_up") {
      session.followUpCount += 1;
    } else if (decision.action === "ask_question" && decision.questionId) {
      session.followUpCount = 0;
      session.sessionQuestionsAsked.push(decision.questionId);
      session.globalQuestionsAsked.push(decision.questionId);
      session.currentQuestionId = decision.questionId;
      saveQuestionProgress(
        session.userId,
        decision.questionId,
        sessionId,
        correlationId,
      ).catch((e) => console.error(`❌ saveQuestionProgress error:`, e));
    }

    // ── Save Veda turn (non-blocking) ─────────────────────────────────────────
    const vedaTurn: ConversationTurn = {
      role: "veda",
      content: decision.speech,
      timestamp: new Date().toISOString(),
      questionId: decision.questionId,
      isFollowUp: decision.action === "follow_up",
    };
    session.conversationHistory.push(vedaTurn);
    activeSessions.set(sessionId, session);
    saveConversationTurn(
      sessionId,
      session.userId,
      vedaTurn,
      correlationId,
    ).catch((e) => console.error(`❌ saveConversationTurn (veda) error:`, e));

    // ── Build XML ──────────────────────────────────────────────────────────────
    const totalMs = Date.now() - startTime;
    console.log(`⚡ [${correlationId}] Total processing: ${totalMs}ms`);

    const nextTurnIndex = turnIndex + 1;
    const actions: AfricasTalkingAction[] = [
      { say: { text: decision.speech, voice: "woman", playBeep: false } },
    ];

    if (decision.action === "end_session") {
      updateInboundSessionStatus(
        sessionId,
        "completed",
        session.sessionQuestionsAsked.length,
        correlationId,
      ).catch(() => {});
      logEvent(
        sessionId,
        "session_completed",
        {
          total_turns: session.conversationHistory.length,
          total_ms: totalMs,
        },
        correlationId,
      ).catch(() => {});
      setTimeout(() => activeSessions.delete(sessionId), 30000);

      return new Response(buildVoiceXML(actions), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    const nextQuestionId = decision.questionId ?? questionId;
    actions.push({
      record: {
        maxLength: ENV.RECORDING_MAX_LENGTH_SECONDS,
        timeout: ENV.RECORDING_TIMEOUT_SECONDS,
        finishOnKey: "#",
        trimSilence: true,
        playBeep: false,
        callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=conversation&questionId=${nextQuestionId}&turnIndex=${nextTurnIndex}`,
      },
    });

    return new Response(buildVoiceXML(actions), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] AI thinking error:`, error);
    return errorResponse();
  }
}

// ─── Identification ───────────────────────────────────────────────────────────

async function handleIdentification(
  session: InboundSession,
  sessionId: string,
  audioBuffer: ArrayBuffer,
  phase: string,
  correlationId: string,
): Promise<Response> {
  const transcript = await transcribeAudio(audioBuffer, correlationId);
  console.log(`🔑 [${correlationId}] Code: "${transcript}"`);

  const profile = await lookupUserByCode(transcript, correlationId);

  if (!profile) {
    if (phase === "identification_retry") {
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "I wasn't able to verify your access code. Please check your code in the app and call back when you're ready. Goodbye.",
              voice: "woman",
              playBeep: false,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }

    session.phase = "identifying";
    activeSessions.set(sessionId, session);

    return new Response(
      buildVoiceXML([
        {
          say: {
            text: "I didn't catch that clearly. Please say your 6-character access code slowly and clearly, then press the hash key.",
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
            callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=identification_retry`,
          },
        },
      ]),
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  console.log(`✅ [${correlationId}] Confirmed: ${profile.name}`);

  const globalProgress = await getUserQuestionProgress(
    profile.userId,
    correlationId,
  );
  const sessionNumber = await getUserSessionCount(
    profile.userId,
    correlationId,
  );

  session.userProfile = profile;
  session.userId = profile.userId;
  session.identifiedViaPhone = false;
  session.globalQuestionsAsked = globalProgress;
  session.phase = "greeting";
  activeSessions.set(sessionId, session);

  createInboundSession(
    sessionId,
    profile.userId,
    session.callerPhone,
    false,
    sessionNumber,
    correlationId,
  ).catch(() => {});
  logEvent(
    sessionId,
    "identity_confirmed",
    { method: "access_code", user_type: profile.userType },
    correlationId,
  ).catch(() => {});

  return await deliverGreetingAndFirstQuestion(
    session,
    sessionId,
    correlationId,
  );
}

// ─── Greeting + first question ────────────────────────────────────────────────

export async function deliverGreetingAndFirstQuestion(
  session: InboundSession,
  sessionId: string,
  correlationId: string,
): Promise<Response> {
  const greetingText = await getGreeting(session);
  const firstQ = await getFirstQuestion(session);

  session.conversationHistory.push({
    role: "veda",
    content: greetingText,
    timestamp: new Date().toISOString(),
  });
  session.conversationHistory.push({
    role: "veda",
    content: firstQ.speech,
    timestamp: new Date().toISOString(),
    questionId: firstQ.questionId,
  });
  session.sessionQuestionsAsked.push(firstQ.questionId);
  session.globalQuestionsAsked.push(firstQ.questionId);
  session.currentQuestionId = firstQ.questionId;
  session.phase = "conversation";
  activeSessions.set(sessionId, session);

  // Non-blocking DB saves
  if (session.userId && firstQ.questionId !== "fallback-first") {
    saveQuestionProgress(
      session.userId,
      firstQ.questionId,
      sessionId,
      correlationId,
    ).catch(() => {});
  }
  saveConversationTurn(
    sessionId,
    session.userId,
    {
      role: "veda",
      content: greetingText,
      timestamp: new Date().toISOString(),
    },
    correlationId,
  ).catch(() => {});
  saveConversationTurn(
    sessionId,
    session.userId,
    {
      role: "veda",
      content: firstQ.speech,
      timestamp: new Date().toISOString(),
      questionId: firstQ.questionId,
    },
    correlationId,
  ).catch(() => {});

  return new Response(
    buildVoiceXML([
      { say: { text: greetingText, voice: "woman", playBeep: false } },
      { say: { text: firstQ.speech, voice: "woman", playBeep: false } },
      {
        record: {
          maxLength: ENV.RECORDING_MAX_LENGTH_SECONDS,
          timeout: ENV.RECORDING_TIMEOUT_SECONDS,
          finishOnKey: "#",
          trimSilence: true,
          playBeep: false,
          callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=conversation&questionId=${firstQ.questionId}&turnIndex=0`,
        },
      },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

// ─── Wrap-up ──────────────────────────────────────────────────────────────────

function buildWrapUp(session: InboundSession): AIDecision {
  const name = session.userProfile?.name?.split(" ")[0] || "there";
  const remaining =
    ENV.MIN_QUESTIONS_FOR_MODEL - session.globalQuestionsAsked.length;
  let closingLine =
    remaining <= 0
      ? "I believe we now have a beautifully complete picture of your wisdom."
      : remaining <= ENV.QUESTIONS_PER_SESSION
        ? "We're very close — just one more session should do it."
        : "We're building something meaningful here, one conversation at a time.";

  return {
    speech: `Thank you so much, ${name}. We've covered a great deal today. ${closingLine} Everything you've shared is being preserved with care. Whenever you're ready for our next conversation, we'll pick up right where we left off. Take good care of yourself.`,
    action: "end_session",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getUserSessionCount(
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

function errorResponse(): Response {
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: "I had a brief technical issue. Could you say that again?",
          voice: "woman",
          playBeep: false,
        },
      },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
