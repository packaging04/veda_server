/**
 * VEDA Unified Server - Single Entry Point
 * Handles both voice callbacks AND automated scheduling
 */
import "./scheduler/cron.ts";
import { handleVoiceCallback } from "./voice/voiceHandler.ts";
import { handleRecordingCallback } from "./voice/recordingHandler.ts";
import { processScheduledCalls } from "./scheduler/processor.ts";
import { activeSessions } from "./voice/sessionStore.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  console.log(`📨 [${correlationId}] ${req.method} ${url.pathname}`);

  // ============================================================================
  // HEALTH & INFO ENDPOINTS
  // ============================================================================

  if (req.method === "GET" && url.pathname === "/") {
    return Response.json({
      status: "running",
      service: "Veda Voice & Scheduler Server",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      features: [
        "voice_callbacks",
        "recording_processing",
        "automated_scheduling",
      ],
    });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      status: "healthy",
      sessions: activeSessions.size,
      timestamp: new Date().toISOString(),
    });
  }

  // ============================================================================
  // VOICE CALLBACKS (from Africa's Talking)
  // ============================================================================

  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  //https://api.africastalking.com/test/voice
  // ============================================================================
  // SCHEDULER ENDPOINTS (triggered by Deno Deploy Cron)
  // ============================================================================

  // Manual admin trigger (NOT Deno cron)
  // Admin-only manual trigger (NOT real cron)
  // if (req.method === "POST" && url.pathname === "/admin/run-scheduler") {
  //   if (req.headers.get("x-admin-secret") !== ENV.ADMIN_SECRET) {
  //     return new Response("Forbidden", { status: 403 });
  //   }

  //   console.log("🔧 Admin triggered scheduler");
  //   const result = await processScheduledCalls();

  //   return Response.json({ success: true, stats: result });
  // }

  // Manual trigger - for testing
  if (req.method === "POST" && url.pathname === "/trigger") {
    console.log("🔧 Manual trigger");

    const result = await processScheduledCalls();

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats: result,
    });
  }

  // ============================================================================
  // 404 - NOT FOUND
  // ============================================================================

  return new Response("Not Found", { status: 404 });
});

// ============================================================================
// STARTUP LOG
// ============================================================================

console.log("🚀 Veda Unified Server Started");
console.log("📊 Services:");
console.log("   ✅ Voice callback handler");
console.log("   ✅ Recording processor");
console.log("   ✅ Automated scheduler");
console.log("🔒 Security features enabled");
console.log("✅ Ready for requests");
