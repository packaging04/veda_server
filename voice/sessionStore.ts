/**
 * Session Store
 * Manages active call sessions with cleanup
 */

import { CallSession } from "../types/voice.ts";
import { ENV } from "../config/env.ts";
import { updateCallStatus } from "../db/supabase.ts";

export const activeSessions = new Map<string, CallSession>();
export const processedCallbacks = new Set<string>();
export const recordingProcessed = new Set<string>();

// Session cleanup every 5 minutes
setInterval(
  () => {
    const now = Date.now();

    for (const [sessionId, session] of activeSessions.entries()) {
      const age = now - new Date(session.lastActivity).getTime();

      if (age > ENV.SESSION_STALE_THRESHOLD_MS) {
        console.log(
          `🧹 Cleaning stale session: ${sessionId} (${Math.round(age / 60000)} mins old)`,
        );

        // Mark as abandoned in database
        const status = session.currentQuestionIndex > 0 ? "failed" : "missed";
        updateCallStatus(
          session.scheduledCallId,
          status,
          sessionId,
          `cleanup-${Date.now()}`,
        );

        activeSessions.delete(sessionId);
      }
    }

    console.log(
      `📊 Sessions: ${activeSessions.size}, Callbacks: ${processedCallbacks.size}, Recordings: ${recordingProcessed.size}`,
    );
  },
  5 * 60 * 1000,
);
