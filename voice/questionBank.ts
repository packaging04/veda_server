/**
 * Question Bank
 * Organized by user type — AI selects and sequences dynamically
 */

export interface BankQuestion {
  id: string;
  text: string;
  category: string;
  userTypes: string[];
  followUpPrompts?: string[]; // hints to AI for drilling deeper
}

export const QUESTION_BANK: BankQuestion[] = [
  // ─── CEO / FOUNDER ───────────────────────────────────────────────────────────
  {
    id: "ceo-001",
    text: "When you're making a major decision, what tends to carry the most weight in your thinking — data, instinct, precedent, or something else entirely?",
    category: "decision_making",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "Ask for a concrete recent example",
      "Explore what happens when data and instinct conflict",
    ],
  },
  {
    id: "ceo-002",
    text: "Can you walk me through a time you fundamentally changed course on something significant? What actually led to that shift?",
    category: "adaptability",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "What was the first signal you almost ignored?",
      "What would have happened if you hadn't shifted?",
    ],
  },
  {
    id: "ceo-003",
    text: "How do you tell the difference between a challenge that just needs more time versus a deeper structural problem in the business?",
    category: "diagnosis",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "What specific signals do you look for?",
      "Has this diagnosis ever been wrong?",
    ],
  },
  {
    id: "ceo-004",
    text: "What kinds of assumptions about your business do you find yourself revisiting most often?",
    category: "mental_models",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-005",
    text: "If resources suddenly became very tight tomorrow, where would you instinctively focus your protection first — and why there?",
    category: "prioritization",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "What would you sacrifice first?",
      "Has scarcity ever revealed something important about the business?",
    ],
  },
  {
    id: "ceo-006",
    text: "How do you personally think about the tension between short-term performance and long-term positioning?",
    category: "strategy",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "Give me an example where they genuinely conflicted",
      "How do you explain this tradeoff to your board or team?",
    ],
  },
  {
    id: "ceo-007",
    text: "When something isn't working, how do you typically figure out whether the root cause is strategic, operational, or cultural?",
    category: "diagnosis",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-008",
    text: "Are there metrics you intentionally avoid over-relying on, even if others in your industry swear by them?",
    category: "mental_models",
    userTypes: ["ceo_founder"],
    followUpPrompts: ["Why that specific metric?", "What do you use instead?"],
  },
  {
    id: "ceo-009",
    text: "How do you navigate situations where your most trusted experts genuinely disagree with each other?",
    category: "decision_making",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-010",
    text: "What qualities do you find absolutely essential in leaders you trust to operate in volatile or ambiguous situations?",
    category: "leadership",
    userTypes: ["ceo_founder"],
    followUpPrompts: ["Who exemplifies this in your organization right now?"],
  },
  {
    id: "ceo-011",
    text: "When a leader on your team is underperforming, how do you assess whether it's fundamentally a people issue or a systems issue?",
    category: "leadership",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-012",
    text: "Are there types of risk you're genuinely more comfortable sitting with than others — and do you think that's a strength or a blind spot?",
    category: "risk",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-013",
    text: "Over time, have you noticed any patterns in how you respond to disruption that you'd want the next generation of leaders in your organization to inherit?",
    category: "legacy",
    userTypes: ["ceo_founder"],
    followUpPrompts: [
      "Has this pattern ever surprised you?",
      "Where does it come from?",
    ],
  },
  {
    id: "ceo-014",
    text: "Looking several years ahead, what decisions being made today do you believe will matter most in hindsight — and why?",
    category: "legacy",
    userTypes: ["ceo_founder"],
  },
  {
    id: "ceo-015",
    text: "What do you wish you had understood about building something lasting that you only figured out the hard way?",
    category: "wisdom",
    userTypes: ["ceo_founder"],
  },

  // ─── PATRIARCH / MATRIARCH ────────────────────────────────────────────────────
  {
    id: "fam-001",
    text: "When you think about the values you've tried to pass down to your family, which one do you feel came through most clearly — and which one you're still hoping takes root?",
    category: "values",
    userTypes: ["patriarch_matriarch"],
    followUpPrompts: [
      "Where did that value come from in you?",
      "Can you think of a moment where you saw it reflected back?",
    ],
  },
  {
    id: "fam-002",
    text: "What's a decision you made years ago that you now see shaped the family in ways you didn't fully anticipate at the time?",
    category: "decisions",
    userTypes: ["patriarch_matriarch"],
  },
  {
    id: "fam-003",
    text: "How did your own upbringing shape the kind of parent or grandparent you became — both the parts you embraced and the parts you deliberately chose to do differently?",
    category: "identity",
    userTypes: ["patriarch_matriarch"],
    followUpPrompts: ["What was the hardest thing to change?"],
  },
  {
    id: "fam-004",
    text: "What do you know now about love and relationships that you wish you'd understood when you were much younger?",
    category: "wisdom",
    userTypes: ["patriarch_matriarch"],
  },
  {
    id: "fam-005",
    text: "When family members disagree or come into conflict, what approach has served you best over the years?",
    category: "relationships",
    userTypes: ["patriarch_matriarch"],
  },
  {
    id: "fam-006",
    text: "What's a hardship or loss that, looking back, you believe made your family stronger in a way you couldn't have seen at the time?",
    category: "resilience",
    userTypes: ["patriarch_matriarch"],
    followUpPrompts: ["How did you hold the family together through it?"],
  },
  {
    id: "fam-007",
    text: "Is there a story about where your family comes from — your roots — that you feel absolutely must be remembered and passed on?",
    category: "legacy",
    userTypes: ["patriarch_matriarch"],
  },
  {
    id: "fam-008",
    text: "What advice would you give your grandchildren or great-grandchildren about building a life that means something?",
    category: "wisdom",
    userTypes: ["patriarch_matriarch"],
  },

  // ─── ALZHEIMER / MEMORY PRESERVATION ─────────────────────────────────────────
  {
    id: "mem-001",
    text: "Tell me about a place from your childhood that feels very vivid in your memory. What do you see, hear, or smell when you go back there in your mind?",
    category: "memories",
    userTypes: ["alzheimer_patient"],
    followUpPrompts: ["Who else is in that memory with you?"],
  },
  {
    id: "mem-002",
    text: "What is something your mother or father used to say or do that stayed with you your whole life?",
    category: "family_memories",
    userTypes: ["alzheimer_patient"],
  },
  {
    id: "mem-003",
    text: "Can you describe a moment in your life where you felt truly proud of yourself?",
    category: "achievements",
    userTypes: ["alzheimer_patient"],
  },
  {
    id: "mem-004",
    text: "What was your most cherished daily routine — something ordinary that you loved?",
    category: "daily_life",
    userTypes: ["alzheimer_patient"],
  },
  {
    id: "mem-005",
    text: "Tell me about the most important friendship of your life. What made that person so special to you?",
    category: "relationships",
    userTypes: ["alzheimer_patient"],
  },
  {
    id: "mem-006",
    text: "What is a piece of wisdom — maybe something you heard once or learned yourself — that you've carried with you for a long time?",
    category: "wisdom",
    userTypes: ["alzheimer_patient"],
  },
  {
    id: "mem-007",
    text: "If your children or grandchildren could know just one thing about who you truly are, what would you want that to be?",
    category: "legacy",
    userTypes: ["alzheimer_patient"],
  },
];

export function getQuestionsForUser(userType: string): BankQuestion[] {
  return QUESTION_BANK.filter(
    (q) => q.userTypes.includes(userType) || q.userTypes.includes("general"),
  );
}
