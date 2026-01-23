/**
 * Supabase Database Operations
 */

import { ENV } from "../config/env.ts";
import { Question } from "../types/voice.ts";

export async function fetchCallDetails(
  scheduledCallId: string,
  correlationId: string,
): Promise<{
  userId: string;
  lovedOneId: string;
  lovedOneName: string;
  phoneNumber: string;
  questions: Question[];
} | null> {
  try {
    console.log(`🔍 [${correlationId}] Fetching call: ${scheduledCallId}`);

    const callResponse = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/scheduled_calls?id=eq.${scheduledCallId}&select=user_id,loved_one_id,interview_session_id,loved_ones(name,phone)`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    if (!callResponse.ok) return null;

    const calls = await callResponse.json();
    if (calls.length === 0) return null;

    const call = calls[0];
    const lovedOne = call.loved_ones;

    // Get questions
    const questionsResponse = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/call_questions?call_id=eq.${scheduledCallId}&select=id,question_order,custom_question_text,questions(question_text)&order=question_order.asc`,
      {
        headers: {
          apikey: ENV.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        },
      },
    );

    let questions: Question[] = [];

    if (questionsResponse.ok) {
      const callQuestions = await questionsResponse.json();
      questions = callQuestions.map((cq: any) => ({
        id: cq.id,
        text:
          cq.custom_question_text ||
          cq.questions?.question_text ||
          "Tell me about your life.",
        order: cq.question_order,
      }));
    }

    // Try interview_session questions if no direct questions
    if (questions.length === 0 && call.interview_session_id) {
      const sessionQuestionsResponse = await fetch(
        `${ENV.SUPABASE_URL}/rest/v1/call_questions?interview_session_id=eq.${call.interview_session_id}&select=id,question_order,custom_question_text,questions(question_text)&order=question_order.asc`,
        {
          headers: {
            apikey: ENV.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
          },
        },
      );

      if (sessionQuestionsResponse.ok) {
        const sessionQuestions = await sessionQuestionsResponse.json();
        questions = sessionQuestions.map((sq: any) => ({
          id: sq.id,
          text:
            sq.custom_question_text ||
            sq.questions?.question_text ||
            "Tell me about your life.",
          order: sq.question_order,
        }));
      }
    }

    // Fallback
    if (questions.length === 0) {
      questions = [
        {
          id: "default-1",
          text: "Tell me about a memorable moment in your life.",
          order: 0,
        },
      ];
    }

    console.log(`✅ [${correlationId}] Loaded ${questions.length} questions`);

    return {
      userId: call.user_id,
      lovedOneId: call.loved_one_id,
      lovedOneName: lovedOne.name,
      phoneNumber: lovedOne.phone,
      questions,
    };
  } catch (error) {
    console.error(`❌ [${correlationId}] Error fetching call:`, error);
    return null;
  }
}

export async function updateCallStatus(
  scheduledCallId: string,
  status: string,
  sessionId: string | null,
  correlationId: string,
): Promise<void> {
  try {
    const updates: any = {
      call_status: status,
      status:
        status === "in_progress"
          ? "in_progress"
          : status === "completed"
            ? "completed"
            : "scheduled",
    };

    if (sessionId) updates.session_id = sessionId;
    if (status === "in_progress")
      updates.call_started_at = new Date().toISOString();
    if (status === "completed")
      updates.call_ended_at = new Date().toISOString();

    await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/scheduled_calls?id=eq.${scheduledCallId}`,
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

    console.log(`✅ [${correlationId}] Updated status: ${status}`);
  } catch (error) {
    console.error(`❌ [${correlationId}] Failed to update status:`, error);
  }
}

export async function saveRecording(
  scheduledCallId: string,
  userId: string,
  lovedOneId: string,
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
        call_id: scheduledCallId,
        user_id: userId,
        loved_one_id: lovedOneId,
        question_id: questionId,
        question_text: questionText,
        question_order: questionOrder,
        recording_url: recordingUrl,
        storage_path: storagePath,
        file_url: recordingUrl,
        duration_seconds: duration,
        file_size_bytes: fileSize,
        transcription_status: "pending",
        title: `Question ${questionOrder + 1}: ${questionText.substring(0, 50)}...`,
      }),
    });

    console.log(`✅ [${correlationId}] Saved recording`);
  } catch (error) {
    console.error(`❌ [${correlationId}] Failed to save recording:`, error);
  }
}

export async function logEvent(
  scheduledCallId: string,
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
        call_id: scheduledCallId,
        event_type: eventType,
        event_data: eventData,
      }),
    });
  } catch (error) {
    console.error(`❌ [${correlationId}] Failed to log event:`, error);
  }
}
