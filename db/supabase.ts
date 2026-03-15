/**
 * Supabase DB Layer — aligned with actual Veda schema
 *
 * Tables used:
 *   profiles              — user accounts
 *   inbound_schedules     — scheduled call windows (call_code, scheduled_date, start_time, end_time)
 *   inbound_sessions      — one row per call session
 *   user_question_progress— multi-session question tracking
 *   conversation_turns    — full transcript
 *   call_recordings       — recording metadata
 *   call_logs             — event log
 */

import { ENV } from "../config/env.ts";
import {
  UserProfile,
  ConversationTurn,
  InboundSession,
} from "../types/voice.ts";

// ─── PHONE NORMALISATION ──────────────────────────────────────────────────────

/**
 * Extract the last N significant digits from any phone format.
 * Works across +234XXXXXXXXXX, 0XXXXXXXXX, 234XXXXXXXXX, etc.
 */
function lastDigits(phone: string, n = 10): string {
  return phone.replace(/\D/g, "").slice(-n);
}

function phonesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return lastDigits(a) === lastDigits(b);
}

/**
 * Fetch first_name/last_name from auth.users metadata as fallback.
 * Used when profiles.first_name is empty (can happen if upsert failed due to RLS).
 */
async function fetchAuthUserName(
  userId: string,
): Promise<{ first_name?: string; last_name?: string }> {
  try {
    const resp = await fetch(
      `${ENV.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!resp.ok) return {};
    const user = await resp.json();
    const meta = user.user_metadata || user.raw_user_meta_data || {};
    return { first_name: meta.first_name, last_name: meta.last_name };
  } catch {
    return {};
  }
}

// ─── USER IDENTIFICATION ──────────────────────────────────────────────────────

/**
 * Look up a user by their phone number during an active call window.
 * Identifies the caller if: their registered phone matches AND there's
 * a 'scheduled' inbound_schedule window containing the current time today.
 */
/**
 * Fetch a single profile row by user id (step 2 of two-step lookups).
 * PostgREST cannot join inbound_schedules → profiles directly because
 * there is no FK between them (both reference auth.users.id separately).
 */
async function fetchProfileById(
  userId: string,
  correlationId: string,
): Promise<any | null> {
  try {
    const resp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/profiles` +
        `?id=eq.${userId}` +
        `&select=id,first_name,last_name,phone,user_type,occupation,legacy_goal,other_name,other_relationship` +
        `&limit=1`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return rows[0] || null;
  } catch (err) {
    console.error(`❌ [${correlationId}] fetchProfileById error:`, err);
    return null;
  }
}

export async function lookupUserByPhone(
  phoneNumber: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    // Deno Deploy runs UTC — Nigeria is UTC+1
    const now = new Date(Date.now() + 60 * 60 * 1000);
    const todayDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const currentTime = now.toISOString().split("T")[1].slice(0, 5); // HH:MM

    console.log(
      `🔍 [${correlationId}] Phone lookup — Nigeria time: ${todayDate} ${currentTime}, caller: ${phoneNumber}`,
    );

    // Step 1: find all scheduled windows active right now
    const resp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_schedules` +
        `?scheduled_date=eq.${todayDate}` +
        `&start_time=lte.${currentTime}` +
        `&end_time=gte.${currentTime}` +
        `&status=eq.scheduled` +
        `&select=call_code,user_id`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    if (!resp.ok) {
      console.error(
        `❌ [${correlationId}] Schedule fetch HTTP ${resp.status}: ${await resp.text()}`,
      );
      return null;
    }

    const windows: { call_code: string; user_id: string }[] = await resp.json();
    console.log(`🔍 [${correlationId}] Active windows: ${windows.length}`);
    if (!windows.length) return null;

    // Step 2: for each window, fetch the profile and check the phone
    for (const win of windows) {
      const profile = await fetchProfileById(win.user_id, correlationId);
      if (!profile) continue;

      console.log(`  → user ${win.user_id}: profile.phone=${profile.phone}`);

      if (phonesMatch(phoneNumber, profile.phone)) {
        const userProfile = await mapProfileToUserProfile(
          profile,
          win.call_code,
        );
        userProfile.totalQuestionsAsked = await getTotalQuestionsAsked(
          userProfile.userId,
          correlationId,
        );
        console.log(
          `✅ [${correlationId}] Identified by phone: ${userProfile.name}`,
        );
        return userProfile;
      }
    }

    console.log(`🔍 [${correlationId}] No phone match found`);
    return null;
  } catch (error) {
    console.error(`❌ [${correlationId}] Phone lookup error:`, error);
    return null;
  }
}

/**
 * Look up a user by their spoken/transcribed call code.
 * Accepts 6-character alphanumeric codes (e.g. "A3B7C2") as well as
 * the old VDA-XXX-XXX format for backwards compatibility.
 * Speech-to-text produces artifacts like spaces, lowercase — normalise all of it.
 */
export async function lookupUserByCode(
  rawCode: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    // Strip spaces, uppercase
    const clean = rawCode.replace(/\s+/g, "").toUpperCase();
    // Also strip any dashes for normalisation
    const stripped = clean.replace(/-/g, "");

    console.log(
      `🔑 [${correlationId}] Code lookup — raw: "${rawCode}", clean: "${clean}", stripped: "${stripped}"`,
    );

    // Build candidate codes to try in order
    const candidates: string[] = [];

    // 1. Numeric-only (primary) — GetDigits sends "382947", strip any noise
    const numericOnly = rawCode.replace(/\D/g, "");
    if (numericOnly.length >= 4) candidates.push(numericOnly);

    // 2. Alphanumeric exact (normalised) — legacy spoken codes
    if (clean && clean !== numericOnly) candidates.push(clean);

    // 3. No-dashes version
    if (stripped && stripped !== clean && stripped !== numericOnly)
      candidates.push(stripped);

    // 4. Legacy VDA-XXX-XXX format
    if (stripped.length === 9) {
      candidates.push(
        `${stripped.slice(0, 3)}-${stripped.slice(3, 6)}-${stripped.slice(6)}`,
      );
    }

    for (const code of [...new Set(candidates)]) {
      if (code.length < 4) continue; // skip noise

      // Step 1: find the schedule row with this code
      const resp = await fetch(
        `${ENV.SUPABASE_URL}/rest/v1/inbound_schedules` +
          `?call_code=eq.${encodeURIComponent(code)}` +
          `&status=eq.scheduled` +
          `&select=call_code,user_id&limit=1`,
        {
          headers: {
            apikey: ENV.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          },
        },
      );

      if (!resp.ok) continue;
      const rows: { call_code: string; user_id: string }[] = await resp.json();
      if (!rows.length) continue;

      // Step 2: fetch the profile for that user_id
      const profile = await fetchProfileById(rows[0].user_id, correlationId);
      if (!profile) continue;

      const userProfile = await mapProfileToUserProfile(profile, code);
      userProfile.totalQuestionsAsked = await getTotalQuestionsAsked(
        userProfile.userId,
        correlationId,
      );

      console.log(
        `✅ [${correlationId}] Identified by code "${code}": ${userProfile.name}`,
      );
      return userProfile;
    }

    console.log(
      `❌ [${correlationId}] No match for candidates: ${[...new Set(candidates)].join(", ")}`,
    );
    return null;
  } catch (error) {
    console.error(`❌ [${correlationId}] Code lookup error:`, error);
    return null;
  }
}

async function mapProfileToUserProfile(
  profile: any,
  callCode: string,
): Promise<UserProfile> {
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

  let firstName = profile.first_name || "";
  let lastName = profile.last_name || "";

  // If names are empty, try auth.users metadata as fallback
  if (!firstName && !lastName && profile.id) {
    const meta = await fetchAuthUserName(profile.id);
    firstName = meta.first_name || "";
    lastName = meta.last_name || "";
  }

  const name = [firstName, lastName].filter(Boolean).join(" ") || "there";

  return {
    userId: profile.id,
    name,
    userType,
    role: profile.occupation || undefined,
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
        Prefer: "return=minimal,resolution=ignore-duplicates",
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
    if (!response.ok) {
      console.error(
        `❌ [${correlationId}] createInboundSession failed: ${await response.text()}`,
      );
      return null;
    }
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

/**
 * Upload audio bytes to Supabase Storage and return a permanent public URL.
 *
 * AT's at-internal.com URLs are temporary — their data retention policy means
 * files can disappear. We download immediately and store in our own bucket.
 *
 * Bucket: call-recordings (create this in Supabase → Storage if it doesn't exist)
 * Path:   {userId}/{sessionId}/{timestamp}.mp3
 *
 * Returns the permanent Supabase Storage URL, or falls back to the original
 * AT URL if the upload fails (so we never lose the reference entirely).
 */
export async function uploadToSupabaseStorage(
  audioBuffer: ArrayBuffer,
  userId: string,
  sessionId: string,
  correlationId: string,
  atRecordingUrl: string,
): Promise<string> {
  try {
    const timestamp = Date.now();
    const filename = `${userId}/${sessionId}/${timestamp}.mp3`;
    const bucket = "call-recordings";

    console.log(
      `⬆️  [${correlationId}] Uploading ${(audioBuffer.byteLength / 1024).toFixed(1)}KB to Supabase Storage: ${filename}`,
    );

    const uploadResp = await fetch(
      `${ENV.SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          apikey: ENV.SUPABASE_SERVICE_KEY,
          "Content-Type": "audio/mpeg",
          "x-upsert": "true",
        },
        body: audioBuffer,
      },
    );

    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      console.error(
        `❌ [${correlationId}] Storage upload failed: ${uploadResp.status} — ${err}`,
      );
      // Fall back to AT URL so we don't lose the reference
      return atRecordingUrl;
    }

    // Build permanent public URL
    const publicUrl = `${ENV.SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
    console.log(
      `✅ [${correlationId}] Uploaded to Supabase Storage: ${publicUrl}`,
    );
    return publicUrl;
  } catch (err) {
    console.error(`❌ [${correlationId}] Storage upload exception:`, err);
    return atRecordingUrl; // graceful fallback
  }
}

export async function saveRecording(
  sessionId: string,
  userId: string,
  questionId: string,
  questionText: string,
  questionOrder: number,
  recordingUrl: string,
  _storagePath: string,
  duration: number,
  _fileSize: number,
  correlationId: string,
  transcript?: string,
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      user_id: userId,
      session_id: sessionId,
      session_title: `Turn ${questionOrder + 1}: ${questionText.substring(0, 50)}`,
      call_code: questionId,
      question_id: questionId,
      duration_seconds: duration,
      recording_url: recordingUrl,
      created_at: new Date().toISOString(),
    };
    if (transcript) {
      body.transcript = transcript;
      body.transcription_status = "completed";
    }
    const resp = await fetch(`${ENV.SUPABASE_URL}/rest/v1/call_recordings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        apikey: ENV.SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(
        `❌ [${correlationId}] saveRecording HTTP error: ${await resp.text()}`,
      );
    }
  } catch (error) {
    console.error(`❌ [${correlationId}] Save recording error:`, error);
  }
}
// ─── EVENT LOGGING ────────────────────────────────────────────────────────────

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

// ─── SESSION REBUILD (Deno isolate fallback) ─────────────────────────────────
//
// Deno Deploy runs across multiple isolates. activeSessions (in-memory Map) is
// isolate-local, so /recording or /ai_thinking may land in a different isolate
// from the one that created the session. This function reconstructs the session
// from Supabase so every request can find it regardless of which isolate runs.

export async function rebuildSessionFromDB(
  sessionId: string,
  correlationId: string,
): Promise<InboundSession | null> {
  try {
    console.log(
      `🔄 [${correlationId}] Rebuilding session from DB: ${sessionId}`,
    );

    // 1. Fetch inbound_session row
    const sessResp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*&limit=1`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!sessResp.ok) return null;
    const sessRows = await sessResp.json();
    if (!sessRows.length) {
      console.error(
        `❌ [${correlationId}] No inbound_session row for ${sessionId}`,
      );
      return null;
    }
    const sessRow = sessRows[0];

    // 2. Fetch user profile
    const profile = await fetchProfileById(sessRow.user_id, correlationId);
    if (!profile) {
      console.error(
        `❌ [${correlationId}] No profile for user ${sessRow.user_id}`,
      );
      return null;
    }
    const userProfile = await mapProfileToUserProfile(
      profile,
      sessRow.call_code || "",
    );

    // 3. Fetch conversation turns (last 20, ordered)
    const turnsResp = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/conversation_turns?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc&limit=20&select=role,content,question_id,created_at`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    const turnsRows: {
      role: string;
      content: string;
      question_id?: string;
      created_at: string;
    }[] = turnsResp.ok ? await turnsResp.json() : [];

    const conversationHistory: ConversationTurn[] = turnsRows.map((t) => ({
      role: t.role as "veda" | "user",
      content: t.content,
      timestamp: t.created_at,
      questionId: t.question_id,
    }));

    // 4. Fetch global question progress
    const globalQuestionsAsked = await getUserQuestionProgress(
      sessRow.user_id,
      correlationId,
    );

    // 5. Derive sessionQuestionsAsked from conversation history
    const sessionQuestionsAsked = conversationHistory
      .filter((t) => t.role === "veda" && t.questionId)
      .map((t) => t.questionId!)
      .filter((id, i, arr) => arr.indexOf(id) === i);

    // 6. Find current question (last Veda question in history)
    const lastVedaQuestion = [...conversationHistory]
      .reverse()
      .find((t) => t.role === "veda" && t.questionId);

    const session: InboundSession = {
      sessionId,
      userId: sessRow.user_id,
      userProfile,
      callerPhone: sessRow.caller_phone || "",
      phase: "conversation",
      conversationHistory,
      sessionQuestionsAsked,
      globalQuestionsAsked,
      currentQuestionId: lastVedaQuestion?.questionId || null,
      followUpCount: 0, // conservatively reset — better than crashing
      pendingRecordingUrl: null,
      pendingTurnIndex: turnsRows.filter((t) => t.role === "user").length,
      pendingQuestionId: lastVedaQuestion?.questionId || "",
      startedAt: sessRow.created_at || new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      identifiedViaPhone: sessRow.identified_via_phone || false,
    };

    console.log(
      `✅ [${correlationId}] Session rebuilt: ${userProfile.name}, ${conversationHistory.length} turns, ${sessionQuestionsAsked.length} questions`,
    );
    return session;
  } catch (error) {
    console.error(`❌ [${correlationId}] rebuildSessionFromDB error:`, error);
    return null;
  }
}
