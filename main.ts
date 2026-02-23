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
      version: "2.0.0",
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

  if (req.method === "GET" && url.pathname === "/voice") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman">Hello. This is Veda. Your voice system is working correctly.</Say></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // ── Core voice flow ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  // Step 1: Receive recording, return instant filler + redirect
  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  // Step 2: Do heavy AI work, return real response
  // AT sends this as GET (following the <Redirect>)
  if (req.method === "GET" && url.pathname === "/ai_thinking") {
    return handleAIThinking(req, correlationId);
  }

  return new Response(
    JSON.stringify({ error: "Not Found", path: url.pathname }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
});

console.log("🚀 Veda Inbound AI Voice Server v2.0");
console.log("📞 Endpoints: POST /voice | POST /recording | GET /ai_thinking");
