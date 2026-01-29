/**
 * Scheduler Caller - Enhanced with full debugging
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

    // 🔍 Debug logging
    console.log(`🔍 Callback URL: ${callbackUrl}`);
    // console.log(`🔍 From: ${ENV.AT_CALLER_ID}`);
    console.log(`🔍 To: ${dueCall.loved_one_phone}`);
    console.log(`🔍 Username: ${ENV.AT_USERNAME}`);

    const body = new URLSearchParams({
      username: ENV.AT_USERNAME,
      // to: dueCall.loved_one_phone,
      to: [dueCall.loved_one_phone].join(","),
      // from: ENV.AT_CALLER_ID,
      callbackUrl,
    });

    console.log(`📤 Making request to Africa's Talking...`);

    const response = await fetch("https://voice.africastalking.com/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey: ENV.AT_API_KEY,
        Accept: "application/json",
      },
      body: body.toString(),
    });

    console.log(`📥 Response status: ${response.status}`);

    const result = await response.json();
    console.log(`📋 Full AT response:`, JSON.stringify(result, null, 2));

    // Check for errors
    if (result.errorMessage && result.errorMessage !== "None") {
      console.error(`❌ AT Error Message: ${result.errorMessage}`);
      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    // Check for entries
    if (!result.entries || result.entries.length === 0) {
      console.error(`❌ No call entries returned from AT`);
      console.error(`❌ This usually means:`);
      console.error(
        `   - Account in sandbox mode (only works with test numbers)`,
      );
      console.error(`   - Phone number not approved for outbound voice`);
      console.error(`   - Insufficient balance`);
      console.error(`   - Invalid destination number`);
      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    const entry = result.entries[0];
    console.log(`📞 Call entry:`, JSON.stringify(entry, null, 2));

    // Check status
    if (entry.status !== "Queued") {
      console.error(`❌ Call not queued. Status: ${entry.status}`);

      // Log specific status meanings
      switch (entry.status) {
        case "InvalidPhoneNumber":
          console.error(
            `   → The destination number ${dueCall.loved_one_phone} is invalid`,
          );
          break;
        case "NotSupported":
          console.error(`   → Voice not supported for this destination`);
          break;
        case "InsufficientBalance":
          console.error(`   → Your AT account has insufficient balance`);
          break;
        case "Rejected":
          console.error(
            `   → Call was rejected by AT (check account permissions)`,
          );
          break;
        default:
          console.error(`   → Unknown status. Check AT dashboard for details`);
      }

      await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
      return false;
    }

    console.log(`✅ Call queued successfully!`);
    console.log(`Session ID: ${entry.sessionId}`);
    console.log(`Phone Number: ${entry.phoneNumber}`);
    console.log(`Status: ${entry.status}`);

    await updateCallStatusScheduler(
      dueCall.scheduled_call_id,
      "initiating",
      entry.sessionId,
    );

    return true;
  } catch (error) {
    console.error(`❌ Error making call:`, error);
    // console.error(`❌ Stack trace:`, error.stack);
    await updateCallStatusScheduler(dueCall.scheduled_call_id, "failed");
    return false;
  } finally {
    processingCalls.delete(callKey);
  }
}
