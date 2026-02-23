/**
 * Session Store — Inbound AI Conversation Sessions
 */

import { InboundSession } from "../types/voice.ts";
import { ENV } from "../config/env.ts";
import { updateInboundSessionStatus } from "../db/supabase.ts";

export const activeSessions = new Map<string, InboundSession>();
export const processedCallbacks = new Set<string>();
export const recordingProcessed = new Set<string>();

// Cleanup every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const cleanupId = `cleanup-${Date.now()}`;

    for (const [sessionId, session] of activeSessions.entries()) {
      const age = now - new Date(session.lastActivity).getTime();

      if (age > ENV.SESSION_STALE_THRESHOLD_MS) {
        console.log(
          `🧹 Stale session cleaned: ${sessionId} (${Math.round(age / 60000)} mins old)`,
        );

        // 4 args: sessionId, status, questionsAskedThisSession, correlationId
        updateInboundSessionStatus(
          sessionId,
          "abandoned",
          session.sessionQuestionsAsked.length,
          cleanupId,
        );

        activeSessions.delete(sessionId);
      }
    }

    console.log(`📊 Active sessions: ${activeSessions.size}`);
  },
  5 * 60 * 1000,
);
