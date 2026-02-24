/**
 * Conversation Handler — Single-step recording + AI response
 *
 * Africa's Talking calls this endpoint (POST) when a <Record> finishes.
 * We do everything here in one shot:
 *   1. Download the audio
 *   2. Transcribe with Whisper
 *   3. Get AI decision from Claude
 *   4. Return the next XML (Say + Record) immediately
 *
 * No redirect, no second endpoint, no cross-isolate session state issues.
 * The user hears a few seconds of silence while we process — this is fine
 * and far better than a dropped call.
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

export async function handleRecordingCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    // Log everything AT sends — helps debugging
    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) fields[k] = v.toString();
    console.log(
      `📼 [${correlationId}] Recording fields:`,
      JSON.stringify(fields),
    );

    const recordingUrl = formData.get("recordingUrl") as string;
    const durationInSeconds = parseInt(
      (formData.get("durationInSeconds") as string) || "0",
    );
    const sessionId = url.searchParams.get("sessionId");
    const phase = url.searchParams.get("phase") || "conversation";
    const questionId = url.searchParams.get("questionId") || "";
    const turnIndex = parseInt(url.searchParams.get("turnIndex") || "0");

    console.log(
      `📼 [${correlationId}] session=${sessionId} phase=${phase} turn=${turnIndex} recordingUrl=${recordingUrl ? "present" : "MISSING"}`,
    );

    if (!sessionId) {
      console.error(`❌ [${correlationId}] No sessionId`);
      return errorXml(
        "I'm sorry, there was a connection issue. Please call back.",
      );
    }

    if (!recordingUrl) {
      // AT sometimes sends the callback before the recording is ready
      // Return a brief hold message
      console.warn(
        `⚠️  [${correlationId}] No recordingUrl — AT may still be processing`,
      );
      return errorXml("One moment please, I'm still processing.");
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found: ${sessionId}`);
      return errorXml(
        "I'm sorry, your session has expired. Please call back to continue.",
      );
    }

    session.lastActivity = new Date().toISOString();
    activeSessions.set(sessionId, session);

    // ── Download audio ─────────────────────────────────────────────────────────
    console.log(
      `⬇️  [${correlationId}] Downloading audio from: ${recordingUrl}`,
    );
    let audioBuffer: ArrayBuffer;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        ENV.FETCH_TIMEOUT_MS,
      );

      const audioResp = await fetch(recordingUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!audioResp.ok) {
        throw new Error(`HTTP ${audioResp.status}`);
      }
      audioBuffer = await audioResp.arrayBuffer();
      console.log(
        `✅ [${correlationId}] Audio downloaded: ${(audioBuffer.byteLength / 1024).toFixed(1)}KB, duration: ${durationInSeconds}s`,
      );
    } catch (err) {
      console.error(`❌ [${correlationId}] Audio download failed:`, err);
      return errorXml(
        "I had trouble receiving your recording. Could you please speak again?",
      );
    }

    // ── Background upload (fire and forget) ───────────────────────────────────
    if (session.userId && audioBuffer.byteLength > 500) {
      const storagePath = `inbound/${session.userId}/${sessionId}/turn-${turnIndex}-${Date.now()}.mp3`;
      uploadToSupabase(
        audioBuffer,
        storagePath,
        sessionId,
        session.userId,
        questionId,
        `Turn ${turnIndex + 1}`,
        turnIndex,
        durationInSeconds,
        correlationId,
      ).catch((e) => console.error(`❌ Upload failed:`, e));
    }

    // ── Route by phase ─────────────────────────────────────────────────────────
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
    console.log(`🎤 [${correlationId}] Transcribing...`);
    const transcript = await transcribeAudio(audioBuffer, correlationId);
    console.log(
      `📝 [${correlationId}] Transcript (${transcript.length} chars): "${transcript.substring(0, 150)}"`,
    );

    if (!transcript.trim()) {
      console.warn(`⚠️  [${correlationId}] Empty transcript`);
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

    // ── Save user turn ─────────────────────────────────────────────────────────
    const userTurn: ConversationTurn = {
      role: "user",
      content: transcript,
      timestamp: new Date().toISOString(),
      questionId,
      audioUrl: recordingUrl,
    };
    session.conversationHistory.push(userTurn);
    activeSessions.set(sessionId, session);
    await saveConversationTurn(
      sessionId,
      session.userId,
      userTurn,
      correlationId,
    );

    // ── AI decision ────────────────────────────────────────────────────────────
    const sessionQCount = session.sessionQuestionsAsked.length;
    const shouldWrap = sessionQCount >= ENV.QUESTIONS_PER_SESSION;

    let decision: AIDecision;
    if (shouldWrap) {
      console.log(
        `📋 [${correlationId}] Session limit (${sessionQCount}/${ENV.QUESTIONS_PER_SESSION}). Wrapping up.`,
      );
      decision = buildWrapUp(session);
    } else {
      console.log(`🧠 [${correlationId}] Calling Claude for decision...`);
      decision = await getAIDecision(session, transcript);
    }

    // ── Update tracking ────────────────────────────────────────────────────────
    if (decision.action === "follow_up") {
      session.followUpCount += 1;
    } else if (decision.action === "ask_question" && decision.questionId) {
      session.followUpCount = 0;
      session.sessionQuestionsAsked.push(decision.questionId);
      session.globalQuestionsAsked.push(decision.questionId);
      session.currentQuestionId = decision.questionId;
      if (session.userId) {
        await saveQuestionProgress(
          session.userId,
          decision.questionId,
          sessionId,
          correlationId,
        );
      }
    }

    // ── Save Veda turn ─────────────────────────────────────────────────────────
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

    // ── Build XML response ─────────────────────────────────────────────────────
    const nextTurnIndex = turnIndex + 1;
    const actions: AfricasTalkingAction[] = [
      { say: { text: decision.speech, voice: "woman", playBeep: false } },
    ];

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
    console.error(`❌ [${correlationId}] Conversation handler error:`, error);
    return errorXml("I had a brief technical issue. Could you say that again?");
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
  console.log(`🔑 [${correlationId}] Code spoken: "${transcript}"`);

  const profile = await lookupUserByCode(transcript, correlationId);

  if (!profile) {
    const isRetry = phase === "identification_retry";
    if (isRetry) {
      console.warn(`⚠️  [${correlationId}] Two failed attempts. Ending.`);
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "I wasn't able to verify your access code after two attempts. Please check your code in the app and call back when you're ready. Goodbye.",
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
            text: "I'm sorry, I didn't catch that clearly. Please say your 6-character access code slowly and clearly, then press the hash key.",
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
    },
    correlationId,
  );

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

  if (session.userId && firstQ.questionId !== "fallback-first") {
    await saveQuestionProgress(
      session.userId,
      firstQ.questionId,
      sessionId,
      correlationId,
    );
  }

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
    },
    correlationId,
  );

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

// ─── Session wrap-up ──────────────────────────────────────────────────────────

function buildWrapUp(session: InboundSession): AIDecision {
  const name = session.userProfile?.name?.split(" ")[0] || "there";
  const globalCount = session.globalQuestionsAsked.length;
  const remaining = ENV.MIN_QUESTIONS_FOR_MODEL - globalCount;

  let closingLine: string;
  if (remaining <= 0) {
    closingLine =
      "I believe we now have a beautifully complete picture of your thinking and wisdom.";
  } else if (remaining <= ENV.QUESTIONS_PER_SESSION) {
    closingLine =
      "We're very close — just one more session like this should do it.";
  } else {
    closingLine =
      "We're building something meaningful here, one conversation at a time.";
  }

  return {
    speech: `Thank you so much, ${name}. We've covered a great deal of important ground today. ${closingLine} Everything you've shared is being preserved with great care. Whenever you're ready for our next conversation, we'll pick up right where we left off. Take good care of yourself.`,
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

function errorXml(message: string): Response {
  return new Response(
    buildVoiceXML([
      { say: { text: message, voice: "woman", playBeep: false } },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
