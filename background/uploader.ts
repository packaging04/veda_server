/**
 * Background Upload Handler
 * Uploads recordings to Supabase asynchronously
 */

import { ENV } from "../config/env.ts";
import { saveRecording, logEvent } from "../db/supabase.ts";
import { transcribeRecording } from "./transcription.ts";

export async function uploadToSupabase(
  audioBuffer: ArrayBuffer,
  storagePath: string,
  scheduledCallId: string,
  userId: string,
  lovedOneId: string,
  questionId: string,
  questionText: string,
  questionOrder: number,
  duration: number,
  correlationId: string,
): Promise<void> {
  try {
    const uploadResponse = await fetch(
      `${ENV.SUPABASE_URL}/storage/v1/object/call-recordings/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "audio/mpeg",
          "x-upsert": "true",
        },
        body: audioBuffer,
      },
    );

    if (uploadResponse.ok) {
      const publicUrl = `${ENV.SUPABASE_URL}/storage/v1/object/call-recordings/${storagePath}`;
      console.log(`✅ [${correlationId}] Uploaded to Supabase`);

      await saveRecording(
        scheduledCallId,
        userId,
        lovedOneId,
        questionId,
        questionText,
        questionOrder,
        publicUrl,
        storagePath,
        duration,
        audioBuffer.byteLength,
        correlationId,
      );

      await logEvent(
        scheduledCallId,
        "recording_saved",
        {
          question_index: questionOrder,
          duration_seconds: duration,
        },
        correlationId,
      );

      // Async transcription
      if (ENV.OPENAI_API_KEY) {
        transcribeRecording(
          audioBuffer,
          scheduledCallId,
          questionId,
          correlationId,
        ).catch((err) => {
          console.error(`❌ [${correlationId}] Transcription failed:`, err);
        });
      }
    } else {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${errorText}`);
    }
  } catch (error) {
    console.error(`❌ [${correlationId}] Upload error:`, error);
    throw error;
  }
}
