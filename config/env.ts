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
  RECORDING_TIMEOUT_SECONDS: 3, // 3s silence = faster response, better UX

  // Session
  SESSION_STALE_THRESHOLD_MS: 45 * 60 * 1000,

  // Multi-session question pacing
  QUESTIONS_PER_SESSION: 4,
  MIN_QUESTIONS_FOR_MODEL: 15,
  MAX_FOLLOW_UPS_PER_TOPIC: 2,

  // Latency filler phrases
  THINKING_FILLERS: [
    "Hmm, give me just a moment to reflect on that.",
    "I see. Let me take a moment with that.",
    "That's really interesting. One moment.",
    "Yes, I want to make sure I'm hearing you properly. Just a moment.",
    "Mmm. Let me sit with that for a second.",
  ],
};

if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY) {
  throw new Error("❌ Supabase credentials required");
}
if (!ENV.BASE_URL) throw new Error("❌ BASE_URL required");
if (!ENV.ANTHROPIC_API_KEY) throw new Error("❌ ANTHROPIC_API_KEY required");

console.log("✅ Environment configuration loaded");
