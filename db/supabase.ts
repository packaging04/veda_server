import { ENV } from "../config/env.ts";
import { UserProfile, ConversationTurn } from "../types/voice.ts";

// ─── USER IDENTIFICATION ──────────────────────────────────────────────────────

export async function lookupUserByPhone(
  phoneNumber: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    const now = new Date().toISOString();
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/inbound_call_windows?phone_number=eq.${encodeURIComponent(phoneNumber)}&window_start=lte.${now}&window_end=gte.${now}&select=user_id,users(id,full_name,user_type,company_name,role_title,industry,family_context,additional_context,access_code)`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    if (!response.ok) return null;
    const windows = await response.json();
    if (!windows.length || !windows[0].users) return null;

    const profile = mapToUserProfile(windows[0].users);
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

export async function lookupUserByCode(
  code: string,
  correlationId: string,
): Promise<UserProfile | null> {
  try {
    const cleanCode = code.replace(/\s+/g, "").toUpperCase();
    const response = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/users?access_code=eq.${encodeURIComponent(cleanCode)}&select=id,full_name,user_type,company_name,role_title,industry,family_context,additional_context,access_code`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    if (!response.ok) return null;
    const users = await response.json();
    if (!users.length) return null;

    const profile = mapToUserProfile(users[0]);
    profile.totalQuestionsAsked = await getTotalQuestionsAsked(
      profile.userId,
      correlationId,
    );
    console.log(
      `✅ [${correlationId}] Identified by code. Past questions: ${profile.totalQuestionsAsked}`,
    );
    return profile;
  } catch (error) {
    console.error(`❌ [${correlationId}] Code lookup error:`, error);
    return null;
  }
}

function mapToUserProfile(user: any): UserProfile {
  return {
    userId: user.id,
    name: user.full_name || "Friend",
    userType: user.user_type || "general",
    company: user.company_name,
    role: user.role_title,
    industry: user.industry,
    familyContext: user.family_context,
    additionalContext: user.additional_context,
    accessCode: user.access_code,
    totalQuestionsAsked: 0,
  };
}

// ─── QUESTION PROGRESS (multi-session tracking) ───────────────────────────────

/**
 * Returns all question IDs this user has already been asked across all sessions.
 * This is what lets us pick up exactly where we left off.
 */
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

/**
 * Saves a newly asked question to the user's permanent progress record.
 */
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
    const updates: any = {
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
    await fetch(`${ENV.SUPABASE_URL}/rest/v1/recordings`, {
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
        question_id: questionId,
        question_text: questionText,
        question_order: questionOrder,
        recording_url: recordingUrl,
        storage_path: storagePath,
        file_url: recordingUrl,
        duration_seconds: duration,
        file_size_bytes: fileSize,
        transcription_status: "pending",
        title: `Turn ${questionOrder + 1}: ${questionText.substring(0, 50)}`,
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Save recording error:`, error);
  }
}

export async function logEvent(
  sessionId: string,
  eventType: string,
  eventData: any,
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
