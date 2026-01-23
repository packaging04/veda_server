/**
 * Environment Configuration
 * Centralized config for entire application
 */

export const ENV = {
  // OpenAI
  OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",

  // Supabase
  SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
  SUPABASE_SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",

  // Voice Server
  BASE_URL: Deno.env.get("BASE_URL") || "",
  MAX_RECORDING_SIZE_MB: 50,
  FETCH_TIMEOUT_MS: 30000,
  AT_ALLOWED_DOMAINS: ["africastalking.com"],
  SESSION_STALE_THRESHOLD_MS: 30 * 60 * 1000, // 30 minutes

  // Africa's Talking
  AT_USERNAME: Deno.env.get("AT_USERNAME") || "",
  AT_CALLER_ID: Deno.env.get("AT_CALLER_ID") || "",
  AT_API_KEY: Deno.env.get("AT_API_KEY") || "",
  CALLBACK_URL: Deno.env.get("CALLBACK_URL") || "",

  // Scheduler
  MAX_CONCURRENT_CALLS: parseInt(Deno.env.get("MAX_CONCURRENT_CALLS") || "5"),
};

// Validate critical config at startup
if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY) {
  throw new Error("❌ Supabase credentials required");
}

if (!ENV.BASE_URL) {
  throw new Error("❌ BASE_URL required");
}

// Validate scheduler config
const requiredSchedulerVars = [
  "AT_USERNAME",
  "AT_API_KEY",
  "AT_CALLER_ID",
  "CALLBACK_URL",
];
for (const varName of requiredSchedulerVars) {
  if (!ENV[varName as keyof typeof ENV]) {
    console.warn(`⚠️  Warning: ${varName} not set - scheduler may not work`);
  }
}

console.log("✅ Environment configuration loaded");
