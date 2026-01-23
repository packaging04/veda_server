import { processScheduledCalls } from "./processor.ts";

Deno.cron("veda-scheduler", "*/1 * * * *", async () => {
  console.log("⏰ [CRON] Scheduler fired");
  await processScheduledCalls();
});

// import { processScheduledCalls } from "./processor.ts";

// if ("cron" in Deno) {
//   Deno.cron("veda-scheduler", "*/1 * * * *", async () => {
//     console.log("⏰ [CRON] Scheduler fired");
//     await processScheduledCalls();
//   });
// } else {
//   console.log("⚠️ Deno.cron not available (local dev)");
// }
