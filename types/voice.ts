export interface Question {
  id: string;
  text: string;
  order: number;
  category?: string;
}

export interface UserProfile {
  userId: string;
  name: string;
  userType:
    | "ceo_founder"
    | "alzheimer_patient"
    | "patriarch_matriarch"
    | "general";
  company?: string;
  role?: string;
  industry?: string;
  familyContext?: string;
  additionalContext?: string;
  accessCode: string;
  totalQuestionsAsked: number; // lifetime total across all sessions
}

export interface ConversationTurn {
  role: "veda" | "user";
  content: string;
  timestamp: string;
  questionId?: string;
  isFollowUp?: boolean;
  audioUrl?: string;
}

export interface InboundSession {
  sessionId: string;
  userId: string;
  userProfile: UserProfile | null;
  callerPhone: string;

  // Conversation state
  phase:
    | "identifying"
    | "identification_retry"
    | "greeting"
    | "conversation"
    | "completing"
    | "complete";
  conversationHistory: ConversationTurn[];

  // Question tracking — two levels
  sessionQuestionsAsked: string[]; // question IDs asked THIS session only
  globalQuestionsAsked: string[]; // question IDs asked across ALL sessions (loaded from DB)
  currentQuestionId: string | null;
  followUpCount: number;

  // Latency bridge — stores recording URL between /recording and /ai_thinking
  pendingRecordingUrl: string | null;
  pendingTurnIndex: number;
  pendingQuestionId: string;

  // Metadata
  startedAt: string;
  lastActivity: string;
  identifiedViaPhone: boolean;
  inboundSessionDbId?: string;
}

export interface AIDecision {
  speech: string;
  action: "ask_question" | "follow_up" | "end_session";
  questionId?: string;
  reasoning?: string;
}

export interface AfricasTalkingAction {
  say?: {
    text: string;
    voice: "male" | "female" | "woman";
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
  // GetDigits — collects DTMF keypad input (for PINs/codes)
  // The Say prompt plays INSIDE the GetDigits element
  getDigits?: {
    timeout: number; // seconds to wait for first digit
    numDigits?: number; // auto-submit after this many digits (no # needed)
    finishOnKey?: string; // key to end collection (e.g. "#")
    callbackUrl: string; // receives POST with dtmfDigits
    promptText: string; // <Say> prompt spoken inside <GetDigits>
  };
}

export interface SchedulerResult {
  success: number;
  failed: number;
  skipped: number;
}
