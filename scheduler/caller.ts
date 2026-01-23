/**
 * Scheduler Caller
 * Makes calls via Africa's Talking
 */

import { ENV } from "../config/env.ts";
import { DueCall } from "../types/voice.ts";
import { updateCallStatusScheduler } from "./database.ts";

const processingCalls = new Set<string>();

export async function makeCall(dueCall: DueCall): Promise<boolean> {
  const callKey = dueCall.scheduled_call_id;

  // Prevent duplicate processing
  if (processingCalls.has(callKey)) {
    console.log(`⏭️  Skipping ${dueCall.loved_one_name} - already processing`);
    return false;
  }

  processingCalls.add(callKey);

  try {
    console.log(
      `📞 Calling ${dueCall.loved_one_name} (${dueCall.loved_one_phone})`,
    );

    const callbackUrl = `${ENV.CALLBACK_URL}?scheduledCallId=${dueCall.scheduled_call_id}`;

    const body = new URLSearchParams({
      username: ENV.AT_USERNAME,
      to: dueCall.loved_one_phone,
      from: ENV.AT_CALLER_ID,
      callbackUrl,
    });

    const response = await fetch("https://voice.africastalking.com/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey: ENV.AT_API_KEY,
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const result = await response.json();

    if (result.errorMessage && result.errorMessage !== "None") {
      console.error(`❌ AT Error: ${result.errorMessage}`);
      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    if (!result.entries || result.entries.length === 0) {
      console.error(`❌ No call entries returned`);
      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    const entry = result.entries[0];

    if (entry.status !== "Queued") {
      console.error(`❌ Call failed: ${entry.status}`);
      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    console.log(`✅ Call queued: ${entry.sessionId}`);

    await updateCallStatusScheduler(
      dueCall.scheduled_call_id,
      "initiating",
      entry.sessionId,
    );

    return true;
  } catch (error) {
    console.error(`❌ Error making call:`, error);
    await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
    return false;
  } finally {
    processingCalls.delete(callKey);
  }
}
