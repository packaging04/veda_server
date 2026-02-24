import { ENV } from "./config/env.ts";
import { handleVoiceCallback } from "./voice/voiceHandler.ts";
// import { handleRecordingCallback } from "./voice/conversationHandler.ts";
import { activeSessions } from "./voice/sessionStore.ts";
import { handleRecordingCallback } from "./voice/Conversationhandler.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  console.log(`📨 [${correlationId}] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/") {
    return Response.json({
      status: "running",
      service: "Veda Inbound AI Voice Server",
      version: "3.0.0",
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

  // GET /voice — AT connectivity check
  if (req.method === "GET" && url.pathname === "/voice") {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="woman">Hello. This is Veda. Your voice system is working.</Say></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } },
    );
  }

  // POST /voice — inbound call arrives
  if (req.method === "POST" && url.pathname === "/voice") {
    return handleVoiceCallback(req, correlationId);
  }

  // POST /recording — AT calls this after <Record> finishes
  // This now does EVERYTHING: download → transcribe → Claude → return XML
  if (req.method === "POST" && url.pathname === "/recording") {
    return handleRecordingCallback(req, correlationId);
  }

  console.warn(`⚠️  [${correlationId}] 404: ${req.method} ${url.pathname}`);
  return new Response(
    JSON.stringify({ error: "Not Found", path: url.pathname }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
});

console.log("🚀 Veda Inbound AI Voice Server v3.0");
console.log("📞 Endpoints: POST /voice | POST /recording");
