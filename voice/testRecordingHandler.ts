/**
 * Test endpoint — verifies the full recording pipeline:
 *   1. Download from AT at-internal.com URL
 *   2. Upload to Supabase Storage bucket
 *   3. Insert row into call_recordings table
 *
 * Call it with:
 *   GET https://veda-production.deno.dev/test-recording
 *
 * Remove this file after testing is confirmed.
 */

import { ENV } from "../config/env.ts";

export async function handleTestRecording(
  _req: Request,
  correlationId: string,
): Promise<Response> {
  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    steps: [],
  };

  const log = (step: string, ok: boolean, detail?: string) => {
    (results.steps as any[]).push({ step, ok, detail });
    console.log(
      `${ok ? "✅" : "❌"} [test] ${step}${detail ? ": " + detail : ""}`,
    );
  };

  // ── Step 1: Download from AT ────────────────────────────────────────────────
  // Use the most recent recording URL from your logs
  const TEST_RECORDING_URL =
    "https://gigantic.keller-shockley.at-internal.com/3ef53cfea9b6a09614abd102fe05d626.mp3";

  let audioBuffer: ArrayBuffer | null = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(TEST_RECORDING_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      log("Download from AT", false, `HTTP ${resp.status}`);
      return Response.json(results, { status: 200 });
    }

    audioBuffer = await resp.arrayBuffer();
    log(
      "Download from AT",
      true,
      `${(audioBuffer.byteLength / 1024).toFixed(1)}KB`,
    );
  } catch (err: any) {
    log("Download from AT", false, err.message);
    return Response.json(results, { status: 200 });
  }

  // ── Step 2: Upload to Supabase Storage ─────────────────────────────────────
  const bucket = "call-recordings";
  const filename = `test/test-upload-${Date.now()}.mp3`;

  try {
    const uploadResp = await fetch(
      `${ENV.SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
          "Content-Type": "audio/mpeg",
          "x-upsert": "true",
        },
        body: audioBuffer,
      },
    );

    const uploadBody = await uploadResp.text();
    if (!uploadResp.ok) {
      log(
        "Upload to Supabase Storage",
        false,
        `HTTP ${uploadResp.status} — ${uploadBody}`,
      );
      return Response.json(results, { status: 200 });
    }

    const publicUrl = `${ENV.SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
    log("Upload to Supabase Storage", true, publicUrl);
    results.publicUrl = publicUrl;
  } catch (err: any) {
    log("Upload to Supabase Storage", false, err.message);
    return Response.json(results, { status: 200 });
  }

  // ── Step 3: Insert row into call_recordings ─────────────────────────────────
  try {
    const insertResp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/call_recordings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          user_id: null,
          session_id: "test-session-" + Date.now(),
          session_title: "TEST — pipeline verification",
          call_code: "TEST",
          question_id: "test",
          duration_seconds: 45,
          recording_url: results.publicUrl,
          transcript:
            "This is a test recording inserted by the /test-recording endpoint.",
          transcription_status: "completed",
          created_at: new Date().toISOString(),
        }),
      },
    );

    const insertBody = await insertResp.text();
    if (!insertResp.ok) {
      log(
        "Insert into call_recordings",
        false,
        `HTTP ${insertResp.status} — ${insertBody}`,
      );
    } else {
      const row = JSON.parse(insertBody);
      log("Insert into call_recordings", true, `id=${row[0]?.id}`);
      results.recordingRowId = row[0]?.id;
    }
  } catch (err: any) {
    log("Insert into call_recordings", false, err.message);
  }

  return Response.json(results, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
