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
  // VOICE ENDPOINTS
  // ============================================================================

  // Test endpoint - GET /voice (for browser/manual testing)
  if (req.method === "GET" && url.pathname === "/voice") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman">
    Hello. This is Veda calling. Your voice system is now working.
  </Say>
  <GetDigits timeout="10" numDigits="1">
    <Say>Press one to continue.</Say>
  </GetDigits>
</Response>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/xml",
          "X-Test-Mode": "true",
        },
      },
    );
  }

  // Production endpoint - POST /voice (from Africa's Talking)
  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  // ============================================================================
  // MANUAL TRIGGER (Testing)
  // ============================================================================

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

  return new Response(
    JSON.stringify({
      error: "Not Found",
      path: url.pathname,
      method: req.method,
      availableEndpoints: [
        "GET /",
        "GET /health",
        "GET /voice (test)",
        "POST /voice (production)",
        "POST /recording",
        "POST /trigger",
      ],
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    },
  );
});

// ============================================================================
// STARTUP LOG
// ============================================================================

console.log("🚀 Veda Unified Server Started");
console.log("📊 Services:");
console.log("   ✅ Voice callback handler (GET test + POST production)");
console.log("   ✅ Recording processor");
console.log("   ✅ Automated scheduler");
console.log("🔒 Security features enabled");
console.log("✅ Ready for requests");
console.log("");
console.log("📍 Available endpoints:");
console.log("   GET  / - Service info");
console.log("   GET  /health - Health check");
console.log("   GET  /voice - Test XML response");
console.log("   POST /voice - Production callback");
console.log("   POST /recording - Recording callback");
console.log("   POST /trigger - Manual scheduler trigger");

// /**
//  * VEDA Unified Server - Single Entry Point
//  * Handles both voice callbacks AND automated scheduling
//  */
// import "./scheduler/cron.ts";
// import { handleVoiceCallback } from "./voice/voiceHandler.ts";
// import { handleRecordingCallback } from "./voice/recordingHandler.ts";
// import { processScheduledCalls } from "./scheduler/processor.ts";
// import { activeSessions } from "./voice/sessionStore.ts";

// Deno.serve(async (req: Request) => {
//   const url = new URL(req.url);
//   const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

//   console.log(`📨 [${correlationId}] ${req.method} ${url.pathname}`);

//   // ============================================================================
//   // HEALTH & INFO ENDPOINTS
//   // ============================================================================

//   if (req.method === "GET" && url.pathname === "/") {
//     return Response.json({
//       status: "running",
//       service: "Veda Voice & Scheduler Server",
//       version: "1.0.0",
//       timestamp: new Date().toISOString(),
//       features: [
//         "voice_callbacks",
//         "recording_processing",
//         "automated_scheduling",
//       ],
//     });
//   }

//   if (req.method === "GET" && url.pathname === "/health") {
//     return Response.json({
//       status: "healthy",
//       sessions: activeSessions.size,
//       timestamp: new Date().toISOString(),
//     });
//   }

//   // ============================================================================
//   // VOICE CALLBACKS (from Africa's Talking)
//   // ============================================================================

//   if (req.method === "POST" && url.pathname === "/voice") {
//     return handleVoiceCallback(req, correlationId);
//   }

//   if (req.method === "POST" && url.pathname === "/recording") {
//     return handleRecordingCallback(req, correlationId);
//   }

//   //https://api.africastalking.com/test/voice

//   // Manual trigger - for testing
//   if (req.method === "POST" && url.pathname === "/trigger") {
//     console.log("🔧 Manual trigger");

//     const result = await processScheduledCalls();

//     return Response.json({
//       success: true,
//       timestamp: new Date().toISOString(),
//       stats: result,
//     });
//   }

//   // ============================================================================
//   // 404 - NOT FOUND
//   // ============================================================================

//   return new Response("Not Found", { status: 404 });
// });

// // ============================================================================
// // STARTUP LOG
// // ============================================================================

// console.log("🚀 Veda Unified Server Started");
// console.log("📊 Services:");
// console.log("   ✅ Voice callback handler");
// console.log("   ✅ Recording processor");
// console.log("   ✅ Automated scheduler");
// console.log("🔒 Security features enabled");
// console.log("✅ Ready for requests");
