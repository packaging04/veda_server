import { ENV } from "./config/env.ts";
import { handleVoiceCallback } from "./voice/voiceHandler.ts";
import { handleRecordingCallback } from "./voice/recordingHandler.ts";
import { handleAIThinking } from "./voice/aiThinkingHandler.ts";
import { activeSessions } from "./voice/sessionStore.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  console.log(`📨 [${correlationId}] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/") {
    return Response.json({
      status: "running",
      service: "Veda Inbound AI Voice Server",
      version: "2.1.0",
      active_sessions: activeSessions.size,
    });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      status: "healthy",
      sessions: activeSessions.size,
      timestamp: new Date().toISOString(),
    });
  }

  // GET /voice — AT uses this for a quick connectivity check
  if (req.method === "GET" && url.pathname === "/voice") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman">Hello. This is Veda. Your voice system is working correctly.</Say></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // POST /voice — real inbound call from Africa's Talking
  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  // POST /recording — AT sends recording details here
  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  // ── /ai_thinking ─────────────────────────────────────────────────────────────
  // IMPORTANT: Africa's Talking sends a POST when following a <Redirect>.
  // We must accept BOTH GET and POST here.
  if (
    (req.method === "GET" || req.method === "POST") &&
    url.pathname === "/ai_thinking"
  ) {
    return handleAIThinking(req, correlationId);
  }

  console.warn(`⚠️  [${correlationId}] 404: ${req.method} ${url.pathname}`);
  return new Response(
    JSON.stringify({
      error: "Not Found",
      path: url.pathname,
      method: req.method,
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
});

console.log("🚀 Veda Inbound AI Voice Server v2.1");
console.log(
  "📞 Endpoints: POST /voice | POST /recording | GET+POST /ai_thinking",
);
