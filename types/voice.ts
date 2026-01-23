/**
 * Type Definitions
 */

export interface Question {
  id: string;
  text: string;
  order: number;
}

export interface CallSession {
  sessionId: string;
  scheduledCallId: string;
  userId: string;
  lovedOneId: string;
  lovedOneName: string;
  phoneNumber: string;
  currentQuestionIndex: number;
  questions: Question[];
  startedAt: string;
  lastActivity: string;
}

export interface AfricasTalkingAction {
  say?: {
    text: string;
    voice: "male" | "female";
    playBeep?: boolean;
  };
  record?: {
    finishOnKey?: string;
    maxLength?: number;
    timeout?: number;
    trimSilence?: boolean;
    playBeep?: boolean;
    callbackUrl?: string;
  };
  pause?: {
    length: number;
  };
  redirect?: {
    url: string;
  };
}

export interface DueCall {
  scheduled_call_id: string;
  call_id: string;
  user_id: string;
  loved_one_id: string;
  loved_one_name: string;
  loved_one_phone: string;
  scheduled_for: string;
  duration_minutes: number;
  interview_session_id: string;
  questions: any[];
}

export interface SchedulerResult {
  success: number;
  failed: number;
  skipped: number;
}
