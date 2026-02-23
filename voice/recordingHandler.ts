/**
 * Recording Handler
 *
 * Step 1 of the latency bridge:
 * - Receives AT's recording callback
 * - Saves the recording URL into the session store
 * - Returns an instant "thinking" filler + Redirect to /ai_thinking
 * - User hears a natural human pause while the heavy work happens
 */

import { ENV } from "../config/env.ts";
import { activeSessions, recordingProcessed } from "./sessionStore.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { validateRecordingUrl } from "../security/helpers.ts";
import { AfricasTalkingAction } from "../types/voice.ts";

export async function handleRecordingCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    const recordingUrl = formData.get("recordingUrl") as string;
    const durationInSeconds = parseInt(
      (formData.get("durationInSeconds") as string) || "0",
    );
    const sessionId = url.searchParams.get("sessionId");
    const phase = url.searchParams.get("phase") || "conversation";
    const questionId = url.searchParams.get("questionId") || "";
    const turnIndex = parseInt(url.searchParams.get("turnIndex") || "0");

    console.log(
      `📼 [${correlationId}] Recording received — session: ${sessionId}, turn: ${turnIndex}`,
    );

    if (!sessionId || !recordingUrl) {
      return naturalErrorResponse();
    }

    // Idempotency
    const recordingKey = `rec-${sessionId}-${turnIndex}-${phase}`;
    if (recordingProcessed.has(recordingKey)) {
      console.log(`⚠️  [${correlationId}] Duplicate recording ignored`);
      return new Response(buildVoiceXML([]), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    recordingProcessed.add(recordingKey);
    setTimeout(() => recordingProcessed.delete(recordingKey), 10 * 60 * 1000);

    // SSRF protection
    if (!validateRecordingUrl(recordingUrl)) {
      console.error(`❌ [${correlationId}] SSRF blocked: ${recordingUrl}`);
      return naturalErrorResponse();
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found: ${sessionId}`);
      return naturalErrorResponse();
    }

    // ── SAVE recording URL into session for /ai_thinking to pick up ──────────
    session.pendingRecordingUrl = recordingUrl;
    session.pendingTurnIndex = turnIndex;
    session.pendingQuestionId = questionId;
    session.lastActivity = new Date().toISOString();
    activeSessions.set(sessionId, session);

    // ── Pick a filler phrase (rotated to feel natural) ────────────────────────
    const fillerIndex = turnIndex % ENV.THINKING_FILLERS.length;
    const filler = ENV.THINKING_FILLERS[fillerIndex];

    // ── Respond INSTANTLY with filler + redirect ──────────────────────────────
    // The user hears the filler while /ai_thinking does Whisper + Claude
    const redirectUrl = `${ENV.BASE_URL}/ai_thinking?sessionId=${sessionId}&phase=${phase}&durationSeconds=${durationInSeconds}`;

    const actions: AfricasTalkingAction[] = [
      {
        say: {
          text: filler,
          voice: "woman",
          playBeep: false,
        },
      },
      {
        redirect: { url: redirectUrl },
      },
    ];

    return new Response(buildVoiceXML(actions), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Recording handler error:`, error);
    return naturalErrorResponse();
  }
}

function naturalErrorResponse(): Response {
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: "I'm sorry, I had a brief moment there. Could you say that again?",
          voice: "woman",
          playBeep: false,
        },
      },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
