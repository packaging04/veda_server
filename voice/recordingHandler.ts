/**
 * Recording Handler
 *
 * Step 1 of the latency bridge:
 * - Receives AT's recording callback (POST from AT after <Record> finishes)
 * - Saves recording URL into the session AND into the redirect URL query param
 * - Returns instant filler phrase + <Redirect> to /ai_thinking
 *
 * IMPORTANT: We encode the recordingUrl as a query param in the redirect URL.
 * This means /ai_thinking does NOT depend on in-memory session state to find
 * the recording. This fixes the multi-isolate / session-not-found failure.
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

    // Log ALL form fields AT sends for debugging
    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) fields[k] = v.toString();
    console.log(
      `📼 [${correlationId}] Recording callback fields:`,
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
      `📼 [${correlationId}] Recording — session: ${sessionId}, phase: ${phase}, turn: ${turnIndex}, url present: ${!!recordingUrl}`,
    );

    if (!sessionId) {
      console.error(`❌ [${correlationId}] No sessionId in recording callback`);
      return naturalErrorResponse();
    }

    if (!recordingUrl) {
      console.error(
        `❌ [${correlationId}] No recordingUrl in recording callback — AT may not have sent it yet`,
      );
      // Return a brief hold message so the call doesn't drop
      return new Response(
        buildVoiceXML([
          {
            say: {
              text: "One moment please.",
              voice: "woman",
              playBeep: false,
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/xml" } },
      );
    }

    // Idempotency check
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

    // SSRF protection — log the URL for debugging before validating
    console.log(`📼 [${correlationId}] Recording URL: ${recordingUrl}`);
    if (!validateRecordingUrl(recordingUrl)) {
      console.error(
        `❌ [${correlationId}] SSRF blocked: ${recordingUrl} — not from africastalking.com`,
      );
      return naturalErrorResponse();
    }

    // Save into in-memory session (best-effort — redirect URL is the reliable path)
    const session = activeSessions.get(sessionId);
    if (session) {
      session.pendingRecordingUrl = recordingUrl;
      session.pendingTurnIndex = turnIndex;
      session.pendingQuestionId = questionId;
      session.lastActivity = new Date().toISOString();
      activeSessions.set(sessionId, session);
    } else {
      console.warn(
        `⚠️  [${correlationId}] Session not in memory (${sessionId}) — using redirect URL as primary`,
      );
    }

    // Filler phrase (rotated)
    const fillerIndex = turnIndex % ENV.THINKING_FILLERS.length;
    const filler = ENV.THINKING_FILLERS[fillerIndex];

    // ── KEY FIX: encode recordingUrl INTO the redirect URL ─────────────────────
    // /ai_thinking will read it from query params as a reliable fallback
    const redirectUrl =
      `${ENV.BASE_URL}/ai_thinking` +
      `?sessionId=${encodeURIComponent(sessionId)}` +
      `&phase=${encodeURIComponent(phase)}` +
      `&durationSeconds=${durationInSeconds}` +
      `&recordingUrl=${encodeURIComponent(recordingUrl)}` +
      `&questionId=${encodeURIComponent(questionId)}` +
      `&turnIndex=${turnIndex}`;

    const actions: AfricasTalkingAction[] = [
      { say: { text: filler, voice: "woman", playBeep: false } },
      { redirect: { url: redirectUrl } },
    ];

    console.log(
      `📼 [${correlationId}] Returning filler + redirect to ai_thinking`,
    );
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
