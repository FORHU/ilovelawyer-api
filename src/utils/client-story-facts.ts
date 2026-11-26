// The facts picked out of a client's story while it's read (the new-client flow's "Understanding your
// story…" screen): short labelled chips, "Date Mar 3, 2026", "Owed 2 months' pay". One small Chat
// Wonder call (ClientStorySvc.facts), apart from the full reading, so the chips show while the
// reading is still going. Shown only, never stored: the reading is what the case keeps.

import { fitsLanguage, type PlanLanguage } from "./client-questions-plan";

export const STORY_FACTS_MAX = 6;
export const FACT_LABEL_MAX_CHARS = 16;
export const FACT_VALUE_MAX_CHARS = 40;

/** The story's start the prompt is given: the facts that matter are told early. */
export const STORY_FACTS_STORY_MAX_CHARS = 3000;

export interface StoryFact {
  label: string;
  value: string;
}

const LANGUAGE_NAME: Record<PlanLanguage, string> = { en: "English", ko: "Korean" };

const EXAMPLES: Record<PlanLanguage, string> = {
  en: `{"facts": [{"label": "Date", "value": "Mar 3, 2026"}, {"label": "Issue", "value": "Dismissal"}, {"label": "Owed", "value": "2 months' pay"}, {"label": "Employer", "value": "Acme Logistics"}]}`,
  ko: `{"facts": [{"label": "날짜", "value": "2026년 3월 3일"}, {"label": "문제", "value": "해고"}, {"label": "못 받은 돈", "value": "2개월 치 임금"}, {"label": "회사", "value": "에이스 물류"}]}`,
};

export function buildStoryFactsPrompt(input: { story: string; language: PlanLanguage; today: string }): string {
  const language = LANGUAGE_NAME[input.language];
  return `A client has just told the story of their legal problem. Pick out its key facts as short labelled chips, so they can see at a glance that they were understood.

Today is ${input.today}.

Their story:
${input.story.slice(0, STORY_FACTS_STORY_MAX_CHARS)}

Give up to ${STORY_FACTS_MAX} facts, the most important first: when it happened, what the problem is, who the other side is, money involved, a deadline, where. Only what the story itself says: never guess, never a legal conclusion or advice. Each label is one or two plain words; each value is a few words, as short as it can be (dates like "Mar 3, 2026"). Write the labels and values in ${language} only (names as the story gives them). No label twice.

Reply with only this JSON and nothing else, for example:
${EXAMPLES[input.language]}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** A value may keep a name in another script (a Korean story's "Acme Logistics"), never Chinese or
 * Japanese, and an English story's values are in English. */
function valueFits(value: string, language: PlanLanguage): boolean {
  return language === "en" ? fitsLanguage(value, "en", "chip") : fitsLanguage(value, "en", "chip") || fitsLanguage(value, "ko");
}

/** The facts in the AI's order, each short, in the story's language, no label twice: none at all
 * when the reply can't be read (the screen simply shows no chips). */
export function parseStoryFactsReply(reply: string, language: PlanLanguage): StoryFact[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const facts: StoryFact[] = [];
  for (const raw of Array.isArray(parsed.facts) ? parsed.facts : []) {
    if (!raw || typeof raw !== "object") continue;
    const label = str((raw as Record<string, unknown>).label);
    const value = str((raw as Record<string, unknown>).value);
    if (!label || !value || label.length > FACT_LABEL_MAX_CHARS || value.length > FACT_VALUE_MAX_CHARS) continue;
    if (!fitsLanguage(label, language) || !valueFits(value, language)) continue;
    if (facts.some((f) => f.label.toLowerCase() === label.toLowerCase())) continue;
    facts.push({ label, value });
    if (facts.length === STORY_FACTS_MAX) break;
  }
  return facts;
}
