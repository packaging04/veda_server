/**
 * Background Transcription Handler
 * Uses OpenAI Whisper for speech-to-text
 */

import { ENV } from "../config/env.ts";

export async function transcribeRecording(
  audioBuffer: ArrayBuffer,
  scheduledCallId: string,
  questionId: string,
  correlationId: string,
): Promise<void> {
  try {
    console.log(`🎤 [${correlationId}] Transcribing...`);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: "audio/mpeg" }),
      "recording.mp3",
    );
    formData.append("model", "whisper-1");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
        body: formData,
      },
    );

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ [${correlationId}] Transcribed`);

      await fetch(
        `${ENV.SUPABASE_URL}/rest/v1/recordings?call_id=eq.${scheduledCallId}&question_id=eq.${questionId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
            apikey: ENV.SUPABASE_SERVICE_KEY,
          },
          body: JSON.stringify({
            transcript: result.text,
            full_transcript: result.text,
            transcription_status: "completed",
          }),
        },
      );
    }
  } catch (error) {
    console.error(`❌ [${correlationId}] Transcription error:`, error);
  }
}
