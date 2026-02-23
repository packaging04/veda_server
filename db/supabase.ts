/**
 * Supabase DB Layer — aligned with actual Veda schema
 *
 * Actual tables:
 *   profiles          — user accounts (id, first_name, last_name, phone, user_type,
 *                       occupation, legacy_goal, profile_completed, calls_remaining,
 *                       subscription_plan, other_name, other_relationship)
 *   inbound_schedules — scheduled call windows (call_code, scheduled_date,
 *                       start_time, end_time, user_id, status)
 *   call_recordings   — per-session recording log (minimal)
 *
 * New tables created by the migration below:
 *   inbound_sessions       — one row per call session
 *   user_question_progress — which questions each user has been asked (multi-session)
 *   conversation_turns     — full transcript of every session
 */

import { ENV } from "../config/env.ts";
import { UserProfile, ConversationTurn } from "../types/voice.ts";

// ─── USER IDENTIFICATION ──────────────────────────────────────────────────────

/**
 * Look up a user by their phone number during an active call window.
 * Checks: profiles.phone matches AND there's a current inbound_schedule window.
 */
export async function lookupUserByPhone(
  phoneNumber: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    const now = new Date();
    const todayDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM

    // Find a profile with this phone that has an active schedule window today
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_schedules?scheduled_date=eq.${todayDate}&start_time=lte.${currentTime}&end_time=gte.${currentTime}&status=eq.scheduled&select=call_code,user_id,profiles(id,first_name,last_name,phone,user_type,occupation,legacy_goal,other_name,other_relationship)`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    if (!response.ok) return null;
    const windows = await response.json();

    // Find a window whose user's phone matches the caller
    const cleanCaller = phoneNumber.replace(/\s+/g, "");
    const match = windows.find((w: any) => {
      const profilePhone = w.profiles?.phone?.replace(/\s+/g, "");
      return (
        profilePhone &&
        cleanCaller.endsWith(
          profilePhone.replace(/^\+234/, "0").replace(/^\+/, ""),
        )
      );
    });

    if (!match || !match.profiles) return null;

    const profile = mapProfileToUserProfile(match.profiles, match.call_code);
    profile.totalQuestionsAsked = await getTotalQuestionsAsked(
      profile.userId,
      correlationId,
    );

    console.log(
      `✅ [${correlationId}] Identified by phone. Past questions: ${profile.totalQuestionsAsked}`,
    );
    return profile;
  } catch (error) {
    console.error(`❌ [${correlationId}] Phone lookup error:`, error);
    return null;
  }
}

/**
 * Look up a user by their spoken/transcribed call code.
 * Matches against inbound_schedules.call_code (e.g. "VDA-ABC-123").
 * Also accepts the code without the VDA- prefix or dashes (speech-to-text artifacts).
 */
export async function lookupUserByCode(
  rawCode: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    // Normalise: strip spaces, uppercase, try multiple formats
    const clean = rawCode.replace(/\s+/g, "").toUpperCase();

    // Build candidate codes from what speech-to-text might produce
    const candidates = new Set<string>();
    candidates.add(clean);
    // "VDA ABC 123" → "VDA-ABC-123"
    candidates.add(
      clean.replace(/([A-Z]{3})([A-Z0-9]{3})([A-Z0-9]{3})/, "$1-$2-$3"),
    );
    // If only 6 chars were heard, try prefixing VDA-
    if (clean.length === 6)
      candidates.add(`VDA-${clean.slice(0, 3)}-${clean.slice(3)}`);

    for (const code of candidates) {
      const response = await fetch(
        `${ENV.SUPABASE_URL}/rest/v1/inbound_schedules?call_code=eq.${encodeURIComponent(code)}&status=eq.scheduled&select=call_code,user_id,profiles(id,first_name,last_name,phone,user_type,occupation,legacy_goal,other_name,other_relationship)`,
        {
          headers: {
            apikey: ENV.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          },
        },
      );

      if (!response.ok) continue;
      const rows = await response.json();
      if (!rows.length || !rows[0].profiles) continue;

      const profile = mapProfileToUserProfile(rows[0].profiles, code);
      profile.totalQuestionsAsked = await getTotalQuestionsAsked(
        profile.userId,
        correlationId,
      );

      console.log(
        `✅ [${correlationId}] Identified by code "${code}". Past questions: ${profile.totalQuestionsAsked}`,
      );
      return profile;
    }

    return null;
  } catch (error) {
    console.error(`❌ [${correlationId}] Code lookup error:`, error);
    return null;
  }
}

function mapProfileToUserProfile(profile: any, callCode: string): UserProfile {
  // Map profiles.user_type → server's UserProfile.userType enum
  const typeMap: Record<string, UserProfile["userType"]> = {
    ceo: "ceo_founder",
    founder: "ceo_founder",
    entrepreneur: "ceo_founder",
    ceo_founder: "ceo_founder",
    alzheimer: "alzheimer_patient",
    alzheimer_patient: "alzheimer_patient",
    elder: "patriarch_matriarch",
    patriarch: "patriarch_matriarch",
    matriarch: "patriarch_matriarch",
    patriarch_matriarch: "patriarch_matriarch",
  };

  const rawType = (profile.user_type || "").toLowerCase();
  const userType: UserProfile["userType"] = typeMap[rawType] || "general";

  const firstName = profile.first_name || "";
  const lastName = profile.last_name || "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || "Friend";

  return {
    userId: profile.id,
    name,
    userType,
    company: undefined,
    role: profile.occupation || undefined,
    industry: undefined,
    familyContext: profile.other_relationship
      ? `Calling on behalf of: ${profile.other_name || "a loved one"} (${profile.other_relationship})`
      : undefined,
    additionalContext: profile.legacy_goal || undefined,
    accessCode: callCode,
    totalQuestionsAsked: 0,
  };
}

// ─── QUESTION PROGRESS (multi-session tracking) ───────────────────────────────

export async function getUserQuestionProgress(
  userId: string,
  correlationId: string,
): Promise<string[]> {
  try {
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/user_question_progress?user_id=eq.${userId}&select=question_id&order=asked_at.asc`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!response.ok) return [];
    const rows = await response.json();
    return rows.map((r: any) => r.question_id);
  } catch (error) {
    console.error(
      `❌ [${correlationId}] Question progress fetch error:`,
      error,
    );
    return [];
  }
}

export async function saveQuestionProgress(
  userId: string,
  questionId: string,
  sessionId: string,
  correlationId: string,
): Promise<void> {
  try {
    await fetch(`${ENV.SUPABASE_URL}/rest/v1/user_question_progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        question_id: questionId,
        session_id: sessionId,
        asked_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Save question progress error:`, error);
  }
}

async function getTotalQuestionsAsked(
  userId: string,
  correlationId: string,
): Promise<number> {
  const progress = await getUserQuestionProgress(userId, correlationId);
  return progress.length;
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────

export async function createInboundSession(
  sessionId: string,
  userId: string,
  callerPhone: string,
  identifiedViaPhone: boolean,
  sessionNumber: number,
  correlationId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          session_id: sessionId,
          user_id: userId,
          caller_phone: callerPhone,
          identified_via_phone: identifiedViaPhone,
          session_number: sessionNumber,
          status: "in_progress",
          started_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) return null;
    const rows = await response.json();
    return rows[0]?.id || null;
  } catch (error) {
    console.error(`❌ [${correlationId}] Create session error:`, error);
    return null;
  }
}

export async function updateInboundSessionStatus(
  sessionId: string,
  status: "in_progress" | "completed" | "abandoned",
  questionsAskedThisSession: number,
  correlationId: string,
): Promise<void> {
  try {
    const updates: Record<string, unknown> = {
      status,
      questions_asked_this_session: questionsAskedThisSession,
    };
    if (status !== "in_progress") updates.ended_at = new Date().toISOString();

    await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_sessions?session_id=eq.${sessionId}`,
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
    console.error(`❌ [${correlationId}] Update session status error:`, error);
  }
}

// ─── CONVERSATION TURNS ───────────────────────────────────────────────────────

export async function saveConversationTurn(
  sessionId: string,
  userId: string,
  turn: ConversationTurn,
  correlationId: string,
): Promise<void> {
  try {
    await fetch(`${ENV.SUPABASE_URL}/rest/v1/conversation_turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        user_id: userId,
        role: turn.role,
        content: turn.content,
        question_id: turn.questionId || null,
        is_follow_up: turn.isFollowUp || false,
        audio_url: turn.audioUrl || null,
        created_at: turn.timestamp,
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Save turn error:`, error);
  }
}

// ─── RECORDINGS ───────────────────────────────────────────────────────────────

export async function saveRecording(
  sessionId: string,
  userId: string,
  questionId: string,
  questionText: string,
  questionOrder: number,
  recordingUrl: string,
  storagePath: string,
  duration: number,
  fileSize: number,
  correlationId: string,
): Promise<void> {
  try {
    // Save to call_recordings (the table from our schema)
    await fetch(`${ENV.SUPABASE_URL}/rest/v1/call_recordings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        session_title: `Turn ${questionOrder + 1}: ${questionText.substring(0, 50)}`,
        call_code: questionId,
        duration_seconds: duration,
        created_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Save recording error:`, error);
  }
}

export async function logEvent(
  sessionId: string,
  eventType: string,
  eventData: unknown,
  correlationId: string,
): Promise<void> {
  try {
    await fetch(`${ENV.SUPABASE_URL}/rest/v1/call_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        event_type: eventType,
        event_data: eventData,
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Log event error:`, error);
  }
}
