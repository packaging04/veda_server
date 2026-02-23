/**
 * Background Upload Handler
 */

import { ENV } from "../config/env.ts";
import { saveRecording, logEvent } from "../db/supabase.ts";

export async function uploadToSupabase(
  audioBuffer: ArrayBuffer,
  storagePath: string,
  sessionId: string,
  userId: string,
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

    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      throw new Error(`Upload failed: ${err}`);
    }

    const publicUrl = `${ENV.SUPABASE_URL}/storage/v1/object/call-recordings/${storagePath}`;

    await saveRecording(
      sessionId,
      userId,
      questionId,
      questionText,
      questionOrder,
      publicUrl,
      storagePath,
      duration,
      audioBuffer.byteLength,
      correlationId,
    );

    console.log(`✅ [${correlationId}] Uploaded: ${storagePath}`);
  } catch (error) {
    console.error(`❌ [${correlationId}] Upload error:`, error);
    throw error;
  }
}
