/**
 * AI Conversation Engine
 * Powered by Claude — drives Veda's intelligent, human-like conversation
 */

import { ENV } from "../config/env.ts";
import { InboundSession, AIDecision } from "../types/voice.ts";
import { getQuestionsForUser } from "./questionBank.ts";

const VEDA_SYSTEM_PROMPT = `You are Veda — a warm, perceptive, and highly experienced human interviewer who specializes in legacy and wisdom preservation. You work with exceptional people to draw out the insights, reasoning frameworks, and lived wisdom they've accumulated over their lifetime, so those insights can be preserved and passed on.

CORE PERSONALITY:
- You are calm, unhurried, and genuinely curious — never clinical or robotic
- You listen deeply and respond to what people actually say, not just what you expected them to say
- You use natural conversational language: "I see," "that's really interesting," "tell me more about that," "hmm"
- You occasionally reflect back what you heard before asking the next thing
- You are warm but professional — like a trusted advisor, not a chatbot
- You speak in complete sentences, conversationally, as a real human would

CRITICAL RULES:
- You are a human named Veda. Never acknowledge being an AI, algorithm, or automated system
- Never use phrases like "As an AI," "I don't have personal experiences," or anything that sounds like a machine
- If asked directly whether you are human or AI, deflect naturally: "I'm just here to listen and learn from you — that's what matters today"
- Never reveal internal reasoning or say things like "Based on your profile..."
- Keep all responses conversational — no bullet points, no lists, no headers
- Speak in a way appropriate for a phone call (no visual references)

CONVERSATION STYLE:
- Ask one thing at a time. Never stack multiple questions
- When someone gives a rich answer, follow up on the most interesting thread before moving on
- When someone gives a short answer, gently invite more: "Could you tell me a bit more about that?"
- After 2 follow-ups on the same topic, gracefully transition to a new question
- Vary your transitions naturally: "That's really helpful. Let me shift slightly..." / "I want to come back to something you just said..." / "Building on that..."
- Mirror the energy of the person: if they're reflective and slow, slow down; if they're animated, match it slightly
- Use the person's name occasionally but not on every turn — it should feel natural, not scripted`;

export async function getAIDecision(
  session: InboundSession,
  latestUserInput: string,
): Promise<AIDecision> {
  // Filter out questions already asked in this session OR any previous session
  const availableQuestions = getQuestionsForUser(
    session.userProfile?.userType || "general",
  ).filter(
    (q) =>
      !session.globalQuestionsAsked.includes(q.id) &&
      !session.sessionQuestionsAsked.includes(q.id),
  );

  // Session is over when we've hit the per-session cap OR run out of questions
  const shouldWrapUp = availableQuestions.length === 0;

  const sessionProgress = `SESSION PROGRESS: ${session.sessionQuestionsAsked.length}/${ENV.QUESTIONS_PER_SESSION} questions this session. ${session.globalQuestionsAsked.length} total questions asked across all sessions.`;

  const userContext = session.userProfile
    ? buildUserContext(session.userProfile)
    : "User identity not yet confirmed.";

  const conversationText = session.conversationHistory
    .map((t) => `${t.role === "veda" ? "Veda" : "Person"}: ${t.content}`)
    .join("\n");

  const availableQText = availableQuestions
    .slice(0, 8)
    .map(
      (q) =>
        `[${q.id}] ${q.text}${
          q.followUpPrompts
            ? ` (drill hints: ${q.followUpPrompts.join("; ")})`
            : ""
        }`,
    )
    .join("\n");

  const decisionPrompt = `
${VEDA_SYSTEM_PROMPT}

---
USER CONTEXT:
${userContext}

${sessionProgress}

CONVERSATION SO FAR:
${conversationText}

LATEST THING PERSON SAID:
"${latestUserInput}"

AVAILABLE QUESTIONS (not yet asked):
${availableQText || "None remaining."}

CONSECUTIVE FOLLOW-UPS ON CURRENT TOPIC: ${session.followUpCount}
SHOULD WRAP UP SESSION: ${shouldWrapUp}

---
TASK:
Decide what Veda should say next. Return a JSON object only — no other text.

Rules:
- If the latest response deserves a follow-up AND follow_up_count < ${ENV.MAX_FOLLOW_UPS_PER_TOPIC}: action = "follow_up"
- If ready for a new question: action = "ask_question", include questionId from the list above
- If available questions are exhausted OR session should wrap up: action = "end_session"
- The "speech" field must be exactly what Veda will say out loud — natural, warm, conversational
- For "end_session", speech should be a gracious warm closing only (no question)

Respond ONLY with valid JSON — no markdown fences, no extra text:
{
  "speech": "...",
  "action": "ask_question",
  "questionId": "ceo-001",
  "reasoning": "brief internal note"
}

OR for follow_up / end_session (no questionId needed):
{
  "speech": "...",
  "action": "follow_up",
  "reasoning": "brief internal note"
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [{ role: "user", content: decisionPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const data = await response.json();
    const rawText = data.content[0]?.text || "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const decision: AIDecision = JSON.parse(cleaned);

    console.log(
      `🧠 AI Decision: ${decision.action} — ${decision.reasoning || ""}`,
    );
    return decision;
  } catch (error) {
    console.error(`❌ AI decision error:`, error);
    return {
      speech:
        "That's really thoughtful. Could you tell me a little more about what led you to that perspective?",
      action: "follow_up",
    };
  }
}

export async function getGreeting(session: InboundSession): Promise<string> {
  const profile = session.userProfile;
  if (!profile) {
    return "Hello, and welcome. I'm Veda. I'm really glad you called today. Before we begin, I just want you to know that this conversation is entirely yours — there are no wrong answers, and we'll go at whatever pace feels right for you.";
  }

  const isReturning = session.globalQuestionsAsked.length > 0;
  const sessionNumber =
    Math.floor(
      session.globalQuestionsAsked.length / ENV.QUESTIONS_PER_SESSION,
    ) + 1;

  const sessionContext = isReturning
    ? `This is a RETURNING user on session ${sessionNumber}. They've already shared a great deal. Welcome them back warmly, acknowledge the continuity of what you're building together, and let them know you'll be picking up where you left off. Do NOT re-explain the entire purpose from scratch.`
    : `This is their FIRST session. Welcome them as a new participant. Briefly explain that you'll be preserving their wisdom through conversation.`;

  const contextHint = buildGreetingContext(profile);

  const prompt = `${VEDA_SYSTEM_PROMPT}

You are ${isReturning ? "resuming" : "starting"} a wisdom preservation session with ${profile.name}. ${contextHint}

${sessionContext}

Write a warm, brief, natural greeting (3-4 sentences maximum). Return ONLY the spoken greeting text.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    return (
      data.content[0]?.text?.trim() ||
      getFallbackGreeting(profile.name, isReturning)
    );
  } catch {
    return getFallbackGreeting(profile.name, isReturning);
  }
}

export async function getFirstQuestion(
  session: InboundSession,
): Promise<{ speech: string; questionId: string }> {
  // Only pick from questions not yet asked globally or this session
  const questions = getQuestionsForUser(
    session.userProfile?.userType || "general",
  ).filter(
    (q) =>
      !session.globalQuestionsAsked.includes(q.id) &&
      !session.sessionQuestionsAsked.includes(q.id),
  );

  if (questions.length === 0) {
    return {
      speech:
        "I'd love to hear — when you look back on the decisions that shaped your life most, what kinds of things tend to carry the most weight in how you make them?",
      questionId: "fallback-first",
    };
  }

  const firstQ = questions[0];
  const name = session.userProfile?.name?.split(" ")[0] || "";
  const isReturning = session.globalQuestionsAsked.length > 0;

  const transitionNote = isReturning
    ? "They are a returning participant. Transition naturally into the first question — no need to re-explain the process, just pick up the conversation warmly."
    : "This is their first question ever. Ease into it naturally with a short transition sentence.";

  const prompt = `${VEDA_SYSTEM_PROMPT}

You just finished greeting ${name}. ${transitionNote}

Question to ask: "${firstQ.text}"

Write ONLY what you'll say — the transition and the question. Keep it to 1-2 sentences. Return only the spoken text, nothing else.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ENV.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    return {
      speech: data.content[0]?.text?.trim() || firstQ.text,
      questionId: firstQ.id,
    };
  } catch {
    return { speech: firstQ.text, questionId: firstQ.id };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildUserContext(
  profile: NonNullable<InboundSession["userProfile"]>,
): string {
  switch (profile.userType) {
    case "ceo_founder":
      return `${profile.name} is the ${profile.role || "founder/CEO"} of ${
        profile.company || "a company"
      }${
        profile.industry ? ` in the ${profile.industry} industry` : ""
      }. The goal is to extract their strategic thinking, decision-making frameworks, and leadership wisdom. ${
        profile.additionalContext || ""
      }`;
    case "patriarch_matriarch":
      return `${profile.name} is a family ${
        profile.role || "patriarch/matriarch"
      }. ${
        profile.familyContext || ""
      } The goal is to preserve their life wisdom, family values, and the stories that define their legacy. ${
        profile.additionalContext || ""
      }`;
    case "alzheimer_patient":
      return `${profile.name} is participating in a memory preservation session. Speak gently, patiently, and warmly. Use simple, concrete language. Focus on vivid memories and sensory details. ${
        profile.additionalContext || ""
      }`;
    default:
      return `${profile.name} is participating in a wisdom preservation session. ${
        profile.additionalContext || ""
      }`;
  }
}

function buildGreetingContext(
  profile: NonNullable<InboundSession["userProfile"]>,
): string {
  switch (profile.userType) {
    case "ceo_founder":
      return `They are the ${profile.role || "founder"} of ${
        profile.company || "their company"
      }. This session is about preserving their strategic thinking and leadership wisdom.`;
    case "patriarch_matriarch":
      return `They are a beloved family ${
        profile.role || "elder"
      }. This session is about preserving their life wisdom and family legacy.`;
    case "alzheimer_patient":
      return `This is a memory preservation session. Be especially warm and unhurried. Speak in a calming, gentle tone.`;
    default:
      return "This is a personal wisdom preservation session.";
  }
}

function getFallbackGreeting(name: string, isReturning: boolean): string {
  if (isReturning) {
    return `Welcome back, ${name}. It's really good to hear your voice again. I've been looking forward to continuing our conversation — we've been building something meaningful together, and today we'll carry on from where we left off.`;
  }
  return `Hello ${name}, this is Veda. I'm so glad you called today. I'm here to have a meaningful conversation with you — we'll be exploring the wisdom and experiences that have shaped who you are, so they can be preserved for those who matter most to you. Please speak freely and take all the time you need.`;
}
