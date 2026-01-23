/**
 * Scheduler Processor
 * Main logic for finding and making scheduled calls
 */

import { ENV } from "../config/env.ts";
import { DueCall, SchedulerResult } from "../types/voice.ts";
import { fetchDueCalls } from "./database.ts";
import { makeCall } from "./caller.ts";

export async function processScheduledCalls(): Promise<SchedulerResult> {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking for due calls...`);

  try {
    const dueCalls = await fetchDueCalls();

    if (dueCalls.length === 0) {
      console.log("✅ No calls due at this time");
      return { success: 0, failed: 0, skipped: 0 };
    }

    console.log(`\n📋 Found ${dueCalls.length} call(s) due:`);
    dueCalls.forEach((call, i) => {
      console.log(
        `   ${i + 1}. ${call.loved_one_name} - ${call.questions.length} questions`,
      );
    });

    // Limit concurrent calls
    const callsToProcess = dueCalls.slice(0, ENV.MAX_CONCURRENT_CALLS);

    if (dueCalls.length > ENV.MAX_CONCURRENT_CALLS) {
      console.log(
        `⚠️  Queue has ${dueCalls.length} calls, processing first ${ENV.MAX_CONCURRENT_CALLS}`,
      );
    }

    console.log(`\n🚀 Initiating calls...`);

    const promises = callsToProcess.map((call) => makeCall(call));
    const results = await Promise.all(promises);

    const successful = results.filter((r) => r).length;
    const failed = results.length - successful;

    console.log(`\n📊 Batch Complete:`);
    console.log(`   ✅ Successful: ${successful}`);
    console.log(`   ❌ Failed: ${failed}`);

    return {
      success: successful,
      failed,
      skipped: dueCalls.length - callsToProcess.length,
    };
  } catch (error) {
    console.error(`❌ Error in scheduler:`, error);
    return { success: 0, failed: 0, skipped: 0 };
  }
}
