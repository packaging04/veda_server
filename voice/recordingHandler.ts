/**
 * Recording Callback Handler
 */

import { ENV } from "../config/env.ts";
import { activeSessions, recordingProcessed } from "./sessionStore.ts";
import { saveRecording, logEvent } from "../db/supabase.ts";
import { buildVoiceXML } from "./voiceXml.ts";
import { validateRecordingUrl } from "../security/helpers.ts";
import { uploadToSupabase } from "../background/uploader.ts";

export async function handleRecordingCallback(
  req: Request,
  correlationId: string,
): Promise<Response> {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    const recordingUrl = formData.get("recordingUrl") as string;
    const durationInSeconds = formData.get("durationInSeconds") as string;
    const sessionId = url.searchParams.get("sessionId");
    const scheduledCallId = url.searchParams.get("scheduledCallId");
    const questionIndex = url.searchParams.get("questionIndex");
    const questionId = url.searchParams.get("questionId");

    if (!sessionId || !scheduledCallId || !questionIndex || !recordingUrl) {
      return errorXml("Missing parameters");
    }

    // IDEMPOTENCY CHECK
    const recordingKey = `recording-${sessionId}-${questionIndex}`;
    if (recordingProcessed.has(recordingKey)) {
      console.log(`⚠️  [${correlationId}] Duplicate recording ignored`);
      const redirectUrl = `${ENV.BASE_URL}/voice?sessionId=${sessionId}&scheduledCallId=${scheduledCallId}`;
      return new Response(buildVoiceXML([{ redirect: { url: redirectUrl } }]), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    recordingProcessed.add(recordingKey);
    setTimeout(() => recordingProcessed.delete(recordingKey), 10 * 60 * 1000);

    // SSRF PROTECTION
    if (!validateRecordingUrl(recordingUrl)) {
      console.error(
        `❌ [${correlationId}] SSRF attempt blocked: ${recordingUrl}`,
      );
      return errorXml("Invalid recording source");
    }

    console.log(
      `📼 [${correlationId}] Recording received for Q${questionIndex}`,
    );

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.error(`❌ [${correlationId}] Session not found`);
      return errorXml("Session expired");
    }

    const qIndex = parseInt(questionIndex);

    if (qIndex < 0 || qIndex >= session.questions.length) {
      console.error(`❌ [${correlationId}] Invalid question index`);
      return errorXml("Invalid question");
    }

    const question = session.questions[qIndex];

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      ENV.FETCH_TIMEOUT_MS,
    );

    try {
      const audioResponse = await fetch(recordingUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!audioResponse.ok) throw new Error(`Download failed`);

      const audioBuffer = await audioResponse.arrayBuffer();
      const fileSizeMB = audioBuffer.byteLength / (1024 * 1024);

      if (fileSizeMB > ENV.MAX_RECORDING_SIZE_MB) {
        throw new Error(`Recording too large: ${fileSizeMB.toFixed(2)}MB`);
      }

      console.log(
        `✅ [${correlationId}] Downloaded ${fileSizeMB.toFixed(2)} MB`,
      );

      const fileName = `${scheduledCallId}/q${qIndex}-${Date.now()}.mp3`;
      const storagePath = `${session.userId}/${fileName}`;

      // Upload async (non-blocking)
      uploadToSupabase(
        audioBuffer,
        storagePath,
        scheduledCallId,
        session.userId,
        session.lovedOneId,
        questionId || question.id,
        question.text,
        qIndex,
        parseInt(durationInSeconds || "0"),
        correlationId,
      ).catch((err) => {
        console.error(`❌ [${correlationId}] Background upload failed:`, err);
      });

      // ATOMIC: Increment only after successful download
      session.currentQuestionIndex = qIndex + 1;
      session.lastActivity = new Date().toISOString();
      activeSessions.set(sessionId, session);

      console.log(
        `✅ [${correlationId}] Advanced to Q${session.currentQuestionIndex + 1}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const redirectUrl = `${ENV.BASE_URL}/voice?sessionId=${sessionId}&scheduledCallId=${scheduledCallId}`;

    return new Response(buildVoiceXML([{ redirect: { url: redirectUrl } }]), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Recording error:`, error);
    return errorXml("Recording failed");
  }
}

function errorXml(message: string): Response {
  return new Response(
    buildVoiceXML([
      {
        say: {
          text: `An error occurred: ${message}. Continuing.`,
          voice: "female",
        },
      },
    ]),
    {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    },
  );
}
