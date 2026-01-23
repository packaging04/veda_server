/**
 * Scheduler Database Operations
 */

import { ENV } from "../config/env.ts";
import { DueCall } from "../types/voice.ts";

export async function fetchDueCalls(): Promise<DueCall[]> {
  try {
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/rpc/get_due_calls`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Failed to fetch due calls: ${error}`);
      return [];
    }

    const calls = await response.json();
    return calls || [];
  } catch (error) {
    console.error(`❌ Error fetching due calls:`, error);
    return [];
  }
}

export async function updateCallStatusScheduler(
  scheduledCallId: string,
  status: string,
  sessionId?: string,
): Promise<void> {
  try {
    const updates: any = {
      call_status: status,
      status: status === "initiating" ? "in_progress" : status,
    };
    if (sessionId) updates.call_sid = sessionId;

    await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/scheduled_calls?id=eq.${scheduledCallId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(updates),
      },
    );
  } catch (error) {
    console.error(`❌ Failed to update status:`, error);
  }
}
