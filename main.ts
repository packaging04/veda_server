import { ENV } from "./config/env.ts";
import { handleVoiceCallback } from "./voice/voiceHandler.ts";
import { handleRecordingCallback } from "./voice/recordingHandler.ts";
import { handleAIThinking } from "./voice/aiThinkingHandler.ts";
import { handleCodeCallback } from "./voice/codeHandler.ts";
import { activeSessions } from "./voice/sessionStore.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  console.log(`📨 [${correlationId}] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/") {
    return Response.json({
      status: "running",
      service: "Veda Inbound AI Voice Server",
      version: "4.0.0",
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
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman">Hello. This is Veda. Your voice system is working.</Say></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // POST /voice — inbound call + completion events from AT
  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  // POST /recording — AT sends recording details here after <Record> finishes
  // Returns INSTANTLY with filler phrase + <Redirect> to /ai_thinking
  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  // POST /code — AT sends DTMF digits here after <GetDigits> finishes
  // Instant PIN lookup — no audio, no Whisper, responds in < 500ms
  if (req.method === "POST" && url.pathname === "/code") {
    return handleCodeCallback(req, correlationId);
  }

  // GET or POST /ai_thinking — AT follows the <Redirect> here
  // AT uses POST when following a <Redirect>, but accept GET too for safety
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

console.log("🚀 Veda Inbound AI Voice Server v4.1 — GetDigits PIN auth");
console.log("📞 Auth: POST /voice → GetDigits → POST /code (DTMF, instant)");
