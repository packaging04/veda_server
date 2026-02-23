/**
 * Transcription — Both sync (for conversation loop) and async (for storage)
 */

import { ENV } from "../config/env.ts";

/**
 * Transcribes audio and returns the text — used synchronously in the conversation loop
 */
export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  correlationId: string,
): Promise<string> {
  try {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: "audio/mpeg" }),
      "recording.mp3",
    );
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
        body: formData,
      },
    );

    if (!response.ok) {
      console.error(`❌ [${correlationId}] Whisper error: ${response.status}`);
      return "";
    }

    const result = await response.json();
    return result.text?.trim() || "";
  } catch (error) {
    console.error(`❌ [${correlationId}] Transcription error:`, error);
    return "";
  }
}

/**
 * Updates an existing recording record with its transcript
 */
export async function updateTranscriptInDB(
  sessionId: string,
  questionId: string,
  transcript: string,
  correlationId: string,
): Promise<void> {
  try {
    const { ENV: env } = await import("../config/env.ts");
    const { ENV: E } = await import("../config/env.ts");

    await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/recordings?session_id=eq.${sessionId}&question_id=eq.${questionId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
        },
        body: JSON.stringify({
          transcript,
          full_transcript: transcript,
          transcription_status: "completed",
        }),
      },
    );
  } catch (error) {
    console.error(`❌ [${correlationId}] Transcript DB update error:`, error);
  }
}
