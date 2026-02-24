/**
 * Recording Handler — responds INSTANTLY, under AT's 15-second timeout
 *
 * Africa's Talking has a hard 15s timeout on voice webhook responses.
 * Processing (download + Whisper + Claude) takes 10–18s — too long for one step.
 *
 * Solution: two-step latency bridge
 *   Step 1 (/recording):  receive callback, respond in < 1s with filler + <Redirect>
 *   Step 2 (/ai_thinking): AT follows redirect (fresh 15s window) → download → transcribe → Claude
 *
 * The filler phrase plays while audio downloads in the background, buying ~4s of overlap.
 * Total effective budget: filler_duration(4s) + ai_thinking_timeout(15s) = ~19s
 * Actual processing (Haiku): download(3s) + Whisper(5s) + Haiku(1.5s) = ~10s ✓
 */

import { ENV } from "../config/env.ts";
import { activeSessions, recordingProcessed } from "./sessionStore.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { AfricasTalkingAction } from "../types/voice.ts";

export async function handleRecordingCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  const startTime = Date.now();

  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    // Log everything AT sends — critical for debugging
    const fields: Record<string, string> = {};
    for (const [k, v] of formData.entries()) fields[k] = v.toString();
    console.log(
      `📼 [${correlationId}] /recording fields:`,
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

    if (!sessionId) {
      console.error(`❌ [${correlationId}] No sessionId`);
      return sayAndHangup(
        "I'm sorry, there was a connection issue. Please call back.",
      );
    }

    if (!recordingUrl) {
      console.error(`❌ [${correlationId}] No recordingUrl in callback`);
      // Return empty to keep the call alive — AT will send completion event
      return new Response(buildVoiceXML([]), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
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

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found: ${sessionId}`);
      return sayAndHangup(
        "I'm sorry, your session has expired. Please call back to continue.",
      );
    }

    // Update session (best-effort — not relied upon for cross-isolate)
    session.pendingRecordingUrl = recordingUrl;
    session.pendingTurnIndex = turnIndex;
    session.pendingQuestionId = questionId;
    session.lastActivity = new Date().toISOString();
    activeSessions.set(sessionId, session);

    // Choose filler (rotated)
    const fillerIndex = turnIndex % ENV.THINKING_FILLERS.length;
    const filler = ENV.THINKING_FILLERS[fillerIndex];

    // ── Encode recordingUrl into the redirect URL ──────────────────────────────
    // /ai_thinking reads it from query params — works even across Deno isolates
    const redirectUrl =
      `${ENV.BASE_URL}/ai_thinking` +
      `?sessionId=${encodeURIComponent(sessionId)}` +
      `&phase=${encodeURIComponent(phase)}` +
      `&durationSeconds=${durationInSeconds}` +
      `&recordingUrl=${encodeURIComponent(recordingUrl)}` +
      `&questionId=${encodeURIComponent(questionId)}` +
      `&turnIndex=${turnIndex}`;

    const elapsed = Date.now() - startTime;
    console.log(
      `📼 [${correlationId}] Responding in ${elapsed}ms with filler + redirect`,
    );

    const actions: AfricasTalkingAction[] = [
      { say: { text: filler, voice: "woman", playBeep: false } },
      { redirect: { url: redirectUrl } },
    ];

    return new Response(buildVoiceXML(actions), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Recording handler error:`, error);
    return new Response(
      buildVoiceXML([
        {
          say: { text: "One moment please.", voice: "woman", playBeep: false },
        },
      ]),
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }
}

function sayAndHangup(message: string): Response {
  return new Response(
    buildVoiceXML([
      { say: { text: message, voice: "woman", playBeep: false } },
    ]),
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}
