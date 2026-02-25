export const ENV = {
  ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY") || "",
  OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") || "",
  SUPABASE_URL: Deno.env.get("SUPABASE_URL") || "",
  SUPABASE_SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  BASE_URL: Deno.env.get("BASE_URL") || "",
  AT_USERNAME: Deno.env.get("AT_USERNAME") || "",
  AT_API_KEY: Deno.env.get("AT_API_KEY") || "",
  AT_CALLER_ID: Deno.env.get("AT_CALLER_ID") || "",
  // AT recording URLs come from at-internal.com subdomains, NOT africastalking.com
  // e.g. https://gigantic.keller-shockley.at-internal.com/xxxx.mp3
  AT_ALLOWED_DOMAINS: [
    "africastalking.com",
    "voice.africastalking.com",
    "at-internal.com",
  ],

  // Recording
  MAX_RECORDING_SIZE_MB: 50,
  FETCH_TIMEOUT_MS: 30000,
  RECORDING_MAX_LENGTH_SECONDS: 300,
  RECORDING_TIMEOUT_SECONDS: 120, // # key is primary trigger — silence is safety net only

  // Session
  SESSION_STALE_THRESHOLD_MS: 45 * 60 * 1000,

  // Multi-session question pacing
  QUESTIONS_PER_SESSION: 4,
  MIN_QUESTIONS_FOR_MODEL: 15,
  MAX_FOLLOW_UPS_PER_TOPIC: 3, // 3 gives Veda room to genuinely drill down

  // Latency filler phrases — play while /ai_thinking processes
  // These fire after user presses #, so they should sound like genuine reflection
  THINKING_FILLERS: [
    "Mmm. Let me sit with that for a moment.",
    "That's really interesting. Give me just a second.",
    "I want to make sure I'm hearing you properly. One moment.",
    "Hmm. Let me reflect on what you've shared.",
    "Thank you for that. Just a moment while I think.",
  ],
};

if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY) {
  throw new Error("❌ Supabase credentials required");
}
if (!ENV.BASE_URL) throw new Error("❌ BASE_URL required");
if (!ENV.ANTHROPIC_API_KEY) throw new Error("❌ ANTHROPIC_API_KEY required");

console.log("✅ Environment configuration loaded");
