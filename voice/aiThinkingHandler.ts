/**
 * AI Thinking Handler
 *
 * Step 2 of the latency bridge:
 * - AT redirects here after the filler phrase plays
 * - We now have time to: download audio → transcribe → get AI decision
 * - Returns the full next XML (Say + Record) to continue the conversation
 *
 * Also handles the end-of-session logic for multi-session pacing.
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
} from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { uploadToSupabase } from "../background/uploader.ts";
import { transcribeAudio } from "../background/transcription.ts";
import {
  getAIDecision,
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
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const phase = url.searchParams.get("phase") || "conversation";
    const durationSeconds = parseInt(
      url.searchParams.get("durationSeconds") || "0",
    );

    if (!sessionId) {
      return errorResponse();
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found: ${sessionId}`);
      return errorResponse();
    }

    const recordingUrl = session.pendingRecordingUrl;
    const turnIndex = session.pendingTurnIndex;
    const questionId = session.pendingQuestionId;

    if (!recordingUrl) {
      console.error(
        `❌ [${correlationId}] No pending recording URL for session ${sessionId}`,
      );
      return errorResponse();
    }

    // Clear pending state immediately so duplicate redirects don't reprocess
    session.pendingRecordingUrl = null;
    activeSessions.set(sessionId, session);

    // ── Download audio ────────────────────────────────────────────────────────
    console.log(`⬇️  [${correlationId}] Downloading audio...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      ENV.FETCH_TIMEOUT_MS,
    );
    let audioBuffer: ArrayBuffer;

    try {
      const audioResponse = await fetch(recordingUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!audioResponse.ok)
        throw new Error(`Audio download failed: ${audioResponse.status}`);

      audioBuffer = await audioResponse.arrayBuffer();

      const sizeMB = audioBuffer.byteLength / (1024 * 1024);
      if (sizeMB > ENV.MAX_RECORDING_SIZE_MB) {
        throw new Error(`Recording too large: ${sizeMB.toFixed(2)}MB`);
      }

      console.log(`✅ [${correlationId}] Downloaded ${sizeMB.toFixed(2)}MB`);
    } finally {
      clearTimeout(timeoutId);
    }

    // ── Upload async (non-blocking — don't wait for this) ─────────────────────
    const storagePath = `inbound/${session.userId}/${sessionId}/turn-${turnIndex}-${Date.now()}.mp3`;
    uploadToSupabase(
      audioBuffer,
      storagePath,
      sessionId,
      session.userId,
      questionId,
      `Turn ${turnIndex + 1}`,
      turnIndex,
      durationSeconds,
      correlationId,
    ).catch((err) =>
      console.error(`❌ [${correlationId}] Background upload failed:`, err),
    );

    // ── Identification phase ───────────────────────────────────────────────────
    if (phase === "identification" || phase === "identification_retry") {
      return await handleIdentification(
        session,
        sessionId,
        audioBuffer,
        correlationId,
      );
    }

    // ── Transcribe (blocking — AI needs the text) ─────────────────────────────
    console.log(`🎤 [${correlationId}] Transcribing...`);
    const transcript = await transcribeAudio(audioBuffer, correlationId);
    console.log(
      `📝 [${correlationId}] Transcript: "${transcript.substring(0, 120)}"`,
    );

    // Handle silence / empty transcript
    if (!transcript.trim()) {
      console.warn(`⚠️  [${correlationId}] Empty transcript — prompting user`);
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "I didn't quite catch that. Take your time — whenever you're ready, please go ahead.",
              voice: "woman",
              playBeep: false,
            },
          },
          { pause: { length: 1 } },
          {
            record: {
              maxLength: ENV.RECORDING_MAX_LENGTH_SECONDS,
              timeout: ENV.RECORDING_TIMEOUT_SECONDS,
              finishOnKey: "#",
              trimSilence: true,
              playBeep: false,
              // Reuse the same turnIndex so we don't advance
              callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=conversation&questionId=${questionId}&turnIndex=${turnIndex}`,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }

    // ── Save user's turn ──────────────────────────────────────────────────────
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

    await saveConversationTurn(
      sessionId,
      session.userId,
      userTurn,
      correlationId,
    );

    // ── Decide: wrap up this session, or continue? ────────────────────────────
    const sessionQCount = session.sessionQuestionsAsked.length;
    const shouldEndSession = sessionQCount >= ENV.QUESTIONS_PER_SESSION;

    let decision: AIDecision;

    if (shouldEndSession) {
      console.log(
        `📋 [${correlationId}] Session limit reached (${sessionQCount}/${ENV.QUESTIONS_PER_SESSION}). Wrapping up.`,
      );
      decision = await getSessionWrapUp(session);
    } else {
      console.log(`🧠 [${correlationId}] Getting AI decision...`);
      decision = await getAIDecision(session, transcript);
    }

    // ── Update counters and question tracking ─────────────────────────────────
    if (decision.action === "follow_up") {
      session.followUpCount += 1;
    } else if (decision.action === "ask_question" && decision.questionId) {
      session.followUpCount = 0;
      session.sessionQuestionsAsked.push(decision.questionId);
      session.globalQuestionsAsked.push(decision.questionId);
      session.currentQuestionId = decision.questionId;

      // Persist immediately — prevents this question being asked again next session
      if (session.userId) {
        await saveQuestionProgress(
          session.userId,
          decision.questionId,
          sessionId,
          correlationId,
        );
      }
    }

    // ── Save Veda's response turn ─────────────────────────────────────────────
    const vedaTurn: ConversationTurn = {
      role: "veda",
      content: decision.speech,
      timestamp: new Date().toISOString(),
      questionId: decision.questionId,
      isFollowUp: decision.action === "follow_up",
    };

    session.conversationHistory.push(vedaTurn);
    activeSessions.set(sessionId, session);

    await saveConversationTurn(
      sessionId,
      session.userId,
      vedaTurn,
      correlationId,
    );

    // ── Build XML response ────────────────────────────────────────────────────
    const nextTurnIndex = turnIndex + 1;
    const actions: AfricasTalkingAction[] = [];

    actions.push({
      say: { text: decision.speech, voice: "woman", playBeep: false },
    });

    // Session ending — no more recording needed
    if (decision.action === "end_session") {
      await updateInboundSessionStatus(
        sessionId,
        "completed",
        session.sessionQuestionsAsked.length,
        correlationId,
      );
      await logEvent(
        sessionId,
        "session_completed",
        {
          session_questions: session.sessionQuestionsAsked.length,
          global_questions: session.globalQuestionsAsked.length,
          total_turns: session.conversationHistory.length,
        },
        correlationId,
      );

      // Delay cleanup so the goodbye speech has time to finish
      setTimeout(() => activeSessions.delete(sessionId), 20000);

      return new Response(buildVoiceXML(actions), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Continue conversation — record the next response
    // Use the new questionId if one was chosen, otherwise carry forward the current one
    const nextQuestionId = decision.questionId ?? questionId;

    actions.push({ pause: { length: 1 } });
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
    console.error(`❌ [${correlationId}] AI thinking handler error:`, error);
    return errorResponse();
  }
}

// ─── Identification flow ──────────────────────────────────────────────────────

async function handleIdentification(
  session: InboundSession,
  sessionId: string,
  audioBuffer: ArrayBuffer,
  correlationId: string,
): Promise<Response> {
  const transcript = await transcribeAudio(audioBuffer, correlationId);
  console.log(`🔑 [${correlationId}] Code attempt: "${transcript}"`);

  const profile = await lookupUserByCode(transcript, correlationId);

  if (!profile) {
    const isRetry = session.phase === "identification_retry";

    if (isRetry) {
      // Two strikes — end gracefully
      console.warn(
        `⚠️  [${correlationId}] Two failed code attempts. Ending call.`,
      );
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "I'm sorry, I wasn't able to verify your access code. Please check your registration email for your code and give us a call back. Goodbye.",
              voice: "woman",
              playBeep: false,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }

    // First failure — give them one more try
    session.phase = "identifying";
    activeSessions.set(sessionId, session);

    return new Response(
      buildVoiceXML([
        {
          say: {
            text: "I'm sorry, I didn't quite catch that, or that code wasn't recognised. Could you please say your access code slowly and clearly? Press the hash key when you're done.",
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
            callbackUrl: `${ENV.BASE_URL}/recording?sessionId=${sessionId}&phase=identification_retry`,
          },
        },
      ]),
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // ── Code matched — load their full history and start the session ──────────
  console.log(`✅ [${correlationId}] Identity confirmed: ${profile.name}`);

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

  await createInboundSession(
    sessionId,
    profile.userId,
    session.callerPhone,
    false,
    sessionNumber,
    correlationId,
  );

  await logEvent(
    sessionId,
    "identity_confirmed",
    {
      method: "access_code",
      user_type: profile.userType,
      past_questions: globalProgress.length,
      session_number: sessionNumber,
    },
    correlationId,
  );

  return await deliverGreetingAndFirstQuestion(
    session,
    sessionId,
    correlationId,
  );
}

// ─── Greeting + first question delivery ──────────────────────────────────────

async function deliverGreetingAndFirstQuestion(
  session: InboundSession,
  sessionId: string,
  correlationId: string,
): Promise<Response> {
  console.log(
    `👋 [${correlationId}] Generating greeting for ${session.userProfile?.name}`,
  );

  const greetingText = await getGreeting(session);
  const firstQ = await getFirstQuestion(session);

  // Add both turns to session history
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
    isFollowUp: false,
  });

  // Register this question as asked
  session.sessionQuestionsAsked.push(firstQ.questionId);
  session.globalQuestionsAsked.push(firstQ.questionId);
  session.currentQuestionId = firstQ.questionId;
  session.phase = "conversation";

  activeSessions.set(sessionId, session);

  // Persist question progress before we return — critical for multi-session tracking
  if (session.userId && firstQ.questionId !== "fallback-first") {
    await saveQuestionProgress(
      session.userId,
      firstQ.questionId,
      sessionId,
      correlationId,
    );
  }

  // Save both Veda turns to DB
  await saveConversationTurn(
    sessionId,
    session.userId,
    {
      role: "veda",
      content: greetingText,
      timestamp: new Date().toISOString(),
    },
    correlationId,
  );

  await saveConversationTurn(
    sessionId,
    session.userId,
    {
      role: "veda",
      content: firstQ.speech,
      timestamp: new Date().toISOString(),
      questionId: firstQ.questionId,
      isFollowUp: false,
    },
    correlationId,
  );

  return new Response(
    buildVoiceXML([
      { say: { text: greetingText, voice: "woman", playBeep: false } },
      { pause: { length: 1 } },
      { say: { text: firstQ.speech, voice: "woman", playBeep: false } },
      { pause: { length: 1 } },
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

// ─── Session wrap-up (called when QUESTIONS_PER_SESSION limit is reached) ─────

async function getSessionWrapUp(session: InboundSession): Promise<AIDecision> {
  const name = session.userProfile?.name?.split(" ")[0] || "there";
  const globalCount = session.globalQuestionsAsked.length;
  const totalNeeded = ENV.MIN_QUESTIONS_FOR_MODEL;

  let closingLine: string;

  if (globalCount < totalNeeded) {
    const remaining = totalNeeded - globalCount;
    const sessionsLeft = Math.ceil(remaining / ENV.QUESTIONS_PER_SESSION);

    if (sessionsLeft <= 1) {
      closingLine = `We're getting very close to having everything we need — just one more session like this one should do it. I'm really looking forward to it.`;
    } else if (sessionsLeft <= 2) {
      closingLine = `We're well on our way. Just a couple more conversations like this and we'll have something truly complete. I look forward to hearing more from you.`;
    } else {
      closingLine = `We're building something really meaningful here, one conversation at a time. There's so much more I'd like to explore with you in our next session.`;
    }
  } else {
    closingLine = `I believe we now have a beautifully complete picture of your thinking and wisdom. What you've shared is going to form something truly remarkable.`;
  }

  const speech = `Thank you so much, ${name}. We've covered a great deal of important ground today, and I want to be respectful of your time. ${closingLine} Everything you've shared is being preserved with great care. Whenever you're ready for our next conversation, we'll pick up right where we left off. Take good care of yourself.`;

  return { speech, action: "end_session" };
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
    console.warn(
      `⚠️  [${correlationId}] Could not fetch session count, defaulting to 1`,
    );
    return 1;
  }
}

function errorResponse(): Response {
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: "I'm sorry, I had a brief technical issue. Could you repeat what you just shared?",
          voice: "woman",
          playBeep: false,
        },
      },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
