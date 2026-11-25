/**
 * The Questions step's pure half (ClientQuestionsSvc): which details a case still needs, the prompt
 * that has the AI write a question for each, and parsing its reply. No Prisma, no Chat Wonder call,
 * so test/client-questions.spec.ts exercises it directly.
 *
 * The details come from a fixed set (QUESTION_DETAILS), always in that order: place first (a UK case
 * with no part of the UK can't be sent to a lawyer), what the client wants last. Which of them are
 * asked is decided here from what the intake reading still lists as missing and what the lawyer
 * readiness check hasn't seen yet; the AI may only drop one the conversation already answers. The
 * list is fixed once written: its length is the "M" in "N of M details".
 */
import type { TenantCode } from "../types/tenant-code";
import { CLIENT_STORY_MAX_LENGTH } from "../constants/client-case.constants";

export const QUESTION_DETAILS = ["place", "otherSide", "relationship", "terms", "reasonGiven", "status", "witnesses", "goal"] as const;
export type QuestionDetail = (typeof QUESTION_DETAILS)[number];

/** At most this many details are asked of one case. */
export const MAX_QUESTIONS = 6;
/** At most this many answer chips under one question. */
export const MAX_CHIPS = 4;
const CHIP_MAX_CHARS = 40;
const QUESTION_MAX_CHARS = 240;
const WHY_MAX_CHARS = 200;
const CONVERSATION_MAX_MESSAGES = 30;
const MESSAGE_MAX_CHARS = 1500;

/** What the client sees of one question: the question, why it's asked, and tappable answers. */
export interface QuestionPrompt {
  question: string;
  why: string;
  /** Empty when the question has no natural short answers: the client types, talks or skips. */
  chips: string[];
}

export type QuestionStatus = "OPEN" | "ANSWERED" | "SKIPPED";

/** The one follow-up a question asked, once its answer called for it. */
export interface AskedFollowUp extends QuestionPrompt {
  status: QuestionStatus;
  answer: string | null;
}

export interface PlannedQuestion extends QuestionPrompt {
  /** Unique in the case's list: the detail's own key. */
  id: QuestionDetail;
  detail: QuestionDetail;
  /** One more question after a given chip, or after any answer ("*"), when that answer would leave
   * the detail incomplete. One level only; it doesn't count toward the total. */
  followUps: Record<string, QuestionPrompt>;
  /** OPEN until the detail is done: answered (and its follow-up, if one was asked, answered or
   * skipped), or skipped. */
  status: QuestionStatus;
  /** The client's answer to the question itself; null while open or when skipped. */
  answer: string | null;
  /** The follow-up actually asked, if any (absent on a list written before follow-ups were kept). */
  followUp?: AskedFollowUp | null;
}

/** A follow-up's id on the screen: its detail's, marked. */
export const followUpId = (detail: QuestionDetail) => `${detail}.followUp`;

/** The UK place chip a typed or spoken answer names, or null when it names none, or more than one
 * ("moved from Glasgow to London"): only a strong signal counts, as the client app's own
 * regionFromDescription. */
export function ukPlaceChipOf(answer: string): (typeof UK_PLACE_CHIPS)[number] | null {
  const text = answer.trim().toLowerCase();
  const exact = UK_PLACE_CHIPS.find((chip) => chip.toLowerCase() === text);
  if (exact) return exact;
  const named = new Set<(typeof UK_PLACE_CHIPS)[number]>();
  if (/\b(?:outside the uk|abroad|overseas|not in the uk)\b/.test(text)) named.add("Outside the UK");
  if (/\b(?:northern ireland|belfast|derry|londonderry)\b/.test(text)) named.add("Northern Ireland");
  if (/\b(?:scotland|edinburgh|glasgow|aberdeen|dundee|inverness)\b/.test(text)) named.add("Scotland");
  if (/(?<!\bnew )\bengland\b|(?<!\bnew south )\bwales\b|\b(?:london|manchester|birmingham|leeds|liverpool|bristol|sheffield|cardiff|swansea)\b/.test(text)) {
    named.add("England and Wales");
  }
  return named.size === 1 ? [...named][0]! : null;
}

/** What answering `question` with `answer` leads to from the list itself: the chip it is (tapped, or
 * typed as one), and the follow-up that chip, or any answer, was given. A UK place answer counts as
 * the region it names. */
export function plannedFollowUp(question: PlannedQuestion, answer: string, tenantCode: TenantCode): { chip: string | null; followUp: QuestionPrompt | null } {
  const text = answer.trim().toLowerCase();
  const chip =
    question.chips.find((c) => c.toLowerCase() === text) ?? (question.detail === "place" && tenantCode === "UK" ? ukPlaceChipOf(answer) : null);
  const followUp = (chip ? question.followUps[chip] : undefined) ?? question.followUps["*"] ?? null;
  return { chip, followUp };
}

/** The small check on a typed or spoken answer: does it answer the question, or does it need one
 * more question to complete the detail? */
export function buildAnswerCheckPrompt(input: { detail: QuestionDetail; question: string; answer: string; tenantCode: TenantCode; language: PlanLanguage }): string {
  return `A client is answering questions about their legal problem before a lawyer reads it. You are not giving legal advice.

The detail being asked for: ${DETAIL_GUIDE[input.detail].replace("{currency}", CURRENCY[input.tenantCode])}
The question: ${input.question}
The client's answer: ${input.answer}

Does the answer give the detail? If it does, or if it plainly says the client doesn't know, it is complete. If it gives only part of it (for example "yes" when the names matter, or a job but no pay when both were asked), write one short follow-up question for the missing part, in ${LANGUAGE_NAME[input.language]} only, in plain everyday words with no legal terms, with a "why" sentence in ${LANGUAGE_NAME[input.language]} saying why their lawyer needs it (never a legal conclusion or advice), and 2 to 4 short chips in ${LANGUAGE_NAME[input.language]}.

Reply with only this JSON and nothing else:
{"complete": true, "followUp": null}
or
{"complete": false, "followUp": {"question": "", "why": "", "chips": []}}`;
}

/** The follow-up the check asks for, or null: complete, unparseable, no usable question, or written
 * in another language than the case's (then the next question just comes). */
export function parseAnswerCheck(reply: string, language: PlanLanguage = "en"): QuestionPrompt | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.complete !== false) return null;
    const followUp = cleanPrompt(parsed.followUp);
    return followUp ? inLanguage(followUp, language, null) : null;
  } catch {
    return null;
  }
}

export interface QuestionPlan {
  version: 1;
  questions: PlannedQuestion[];
  /** Details the AI found already answered, with its reason: logged, never asked. */
  dropped: { detail: QuestionDetail; because: string }[];
  /** The questions' language, from the story (absent on a list written before it was kept: English). */
  language?: PlanLanguage;
}

/** What the case and its intake reading say about what's known (ClientIntakeSvc's CaseIntake). */
export interface OpenDetailsInput {
  tenantCode: TenantCode;
  place: { ukJurisdiction: string | null; outsideUk: boolean; where: string | null };
  /** formFields.missing. */
  missing: string[];
  /** The readiness points the check found unmet; null when it hasn't run (or is switched off). */
  unmetReadiness: string[] | null;
}

/** The details still open for this case, in the fixed order. */
export function openDetails({ tenantCode, place, missing, unmetReadiness }: OpenDetailsInput): QuestionDetail[] {
  const lacks = (field: string) => missing.includes(field);
  const unmet = (key: string) => unmetReadiness?.includes(key) ?? false;
  const placeOpen = tenantCode === "UK" ? (!place.ukJurisdiction && !place.outsideUk) || unmet("place") : !place.where?.trim();
  const open: Record<QuestionDetail, boolean> = {
    place: placeOpen,
    otherSide: lacks("parties") || unmet("otherSide"),
    relationship: lacks("relationship"),
    terms: lacks("roleAndTerms"),
    reasonGiven: lacks("reasonGiven"),
    // Not yet checked counts as open: the AI drops it if the story already says where things stand.
    status: unmetReadiness === null || unmet("status"),
    witnesses: lacks("witnesses"),
    goal: lacks("clientGoals") || unmet("goal"),
  };
  return QUESTION_DETAILS.filter((detail) => open[detail]);
}

/** At most MAX_QUESTIONS, keeping place first and what the client wants last: the ones in between
 * give way, latest first. */
export function capQuestions<T extends { detail: QuestionDetail }>(questions: T[]): T[] {
  if (questions.length <= MAX_QUESTIONS) return questions;
  const goal = questions.find((q) => q.detail === "goal");
  const rest = questions.filter((q) => q.detail !== "goal");
  return goal ? [...rest.slice(0, MAX_QUESTIONS - 1), goal] : rest.slice(0, MAX_QUESTIONS);
}

/** The UK's place question, written by the app rather than the AI: its chips are the exact values
 * the case stores (ukJurisdiction, or outside the UK), and a UK place is then asked for its town. */
export const UK_PLACE_CHIPS = ["England and Wales", "Scotland", "Northern Ireland", "Outside the UK"] as const;
export function ukPlaceQuestion(): PlannedQuestion {
  // The town follow-up offers that part of the UK's largest towns; any other is typed.
  const town = (chips: string[]): QuestionPrompt => ({ question: "Which town or city?", why: "It helps find a lawyer near you.", chips });
  return {
    id: "place",
    detail: "place",
    question: "Which part of the UK did this happen in?",
    why: "Lawyers take cases in the part of the UK where they're qualified.",
    chips: [...UK_PLACE_CHIPS],
    followUps: {
      "England and Wales": town(["London", "Manchester", "Birmingham", "Cardiff"]),
      Scotland: town(["Glasgow", "Edinburgh", "Aberdeen", "Dundee"]),
      "Northern Ireland": town(["Belfast", "Derry", "Lisburn", "Newry"]),
    },
    status: "OPEN",
    answer: null,
  };
}

/** Whether the client wrote in Korean: any Hangul syllable in their story. */
export function writesInKorean(text: string): boolean {
  return /[가-힣]/.test(text);
}

/** The language a case's questions are in: the story's. Korean when it has any Korean in it,
 * English otherwise (the UK, and a KR client who wrote in English). */
export type PlanLanguage = "en" | "ko";
export const languageOf = (storyText: string): PlanLanguage => (writesInKorean(storyText) ? "ko" : "en");
const LANGUAGE_NAME: Record<PlanLanguage, string> = { en: "English", ko: "Korean" };

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
/** Japanese kana and Chinese characters: never right in either language's questions. */
const OTHER_CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/** Whether `text` is written in `language`. Korean text has Korean in it, though a chip may be only
 * numbers and units ("2023", "₩200"): it just mustn't be an English word with no Korean. English
 * text has no Korean. Neither may have Chinese characters or Japanese kana, which the AI has slipped
 * into before. */
export function fitsLanguage(text: string, language: PlanLanguage, kind: "text" | "chip" = "text"): boolean {
  if (OTHER_CJK.test(text)) return false;
  if (language === "en") return !HANGUL.test(text);
  if (HANGUL.test(text)) return true;
  return kind === "chip" && !/[A-Za-z]{2,}/.test(text);
}

/** The app's own wording for each detail, used wherever the AI's is missing or in the wrong
 * language, so every question reads in the story's language and has chips to tap. */
const DEFAULT_PROMPTS: Record<Exclude<QuestionDetail, "place">, Record<PlanLanguage, QuestionPrompt>> = {
  otherSide: {
    en: { question: "Who is the problem with?", why: "Your lawyer needs to know who the other side is.", chips: ["My employer", "My landlord", "A business or shop", "A person"] },
    ko: { question: "누구와의 문제인가요?", why: "변호사가 상대방이 누구인지 알아야 해요.", chips: ["고용주(회사)", "집주인", "업체나 가게", "개인"] },
  },
  relationship: {
    en: { question: "How are you connected to them, and since when?", why: "It shows what kind of agreement you had.", chips: ["I work for them", "I rent from them", "I'm their customer", "Something else"] },
    ko: { question: "상대방과 어떤 관계이고, 언제부터였나요?", why: "어떤 약속이나 계약이 있었는지 알 수 있어요.", chips: ["그곳에서 일해요", "그곳에서 세 들어 살아요", "그곳의 고객이에요", "그 밖의 관계예요"] },
  },
  terms: {
    en: { question: "What was your role, and how much money is involved?", why: "It shows what you may be owed.", chips: [] },
    ko: { question: "어떤 일을 하셨고, 관련된 금액은 얼마인가요?", why: "받을 수 있는 금액을 파악하는 데 필요해요.", chips: [] },
  },
  reasonGiven: {
    en: { question: "Did they give a reason for what they did?", why: "Your lawyer needs their side as they told it.", chips: ["No reason given", "Poor performance", "Cutting costs", "Something I did"] },
    ko: { question: "상대방이 그렇게 한 이유를 말했나요?", why: "변호사가 상대방이 말한 이유를 알아야 해요.", chips: ["이유를 말하지 않았어요", "업무 성과 때문이라고 했어요", "비용 절감 때문이라고 했어요", "제 잘못 때문이라고 했어요"] },
  },
  status: {
    en: { question: "Have you heard from them since?", why: "It shows where things stand now.", chips: ["No contact since", "They replied", "I complained in writing", "I've started a claim"] },
    ko: { question: "그 뒤로 상대방에게서 연락이 있었나요?", why: "지금 상황이 어떤지 알 수 있어요.", chips: ["그 뒤로 연락이 없어요", "상대방이 답을 했어요", "서면으로 항의했어요", "이미 신고나 소송을 했어요"] },
  },
  witnesses: {
    en: { question: "Did anyone else see or hear what happened?", why: "Someone who saw it can back you up.", chips: ["Yes, someone saw it", "No, just us", "I have messages or emails"] },
    ko: { question: "그 일을 보거나 들은 사람이 있나요?", why: "본 사람이 있으면 말씀을 뒷받침할 수 있어요.", chips: ["네, 본 사람이 있어요", "아니요, 둘뿐이었어요", "문자나 이메일이 있어요"] },
  },
  goal: {
    en: { question: "What would you like to happen?", why: "It tells your lawyer what to ask for.", chips: ["Get paid what I'm owed", "Get my job or home back", "An apology or a fix", "Know my options"] },
    ko: { question: "어떻게 되기를 원하세요?", why: "변호사가 무엇을 요구할지 알 수 있어요.", chips: ["받을 돈을 받고 싶어요", "일자리나 집을 되찾고 싶어요", "사과나 시정을 원해요", "선택지를 알고 싶어요"] },
  },
};

/** Money chips for the terms question, by site and language: monthly amounts in the site's currency. */
function termsChips(tenantCode: TenantCode, language: PlanLanguage): string[] {
  if (tenantCode === "KR") {
    return language === "ko"
      ? ["월 200만 원 미만", "월 200만~350만 원", "월 350만~500만 원", "월 500만 원 이상"]
      : ["Under ₩2M a month", "₩2M – ₩3.5M a month", "₩3.5M – ₩5M a month", "Over ₩5M a month"];
  }
  if (tenantCode === "PH") return ["Below ₱15,000 a month", "₱15,000 – 25,000 a month", "₱25,000 – 40,000 a month", "Above ₱40,000 a month"];
  return ["Under £1,500 a month", "£1,500 – £2,500 a month", "£2,500 – £4,000 a month", "Over £4,000 a month"];
}

/** The app's own question for a detail (not place, which has its own), in `language`. */
export function defaultPrompt(detail: Exclude<QuestionDetail, "place">, language: PlanLanguage, tenantCode: TenantCode): QuestionPrompt {
  const prompt = DEFAULT_PROMPTS[detail][language];
  return { ...prompt, chips: detail === "terms" ? termsChips(tenantCode, language) : [...prompt.chips] };
}

/** The place question outside the UK (KR), in the app's own words rather than the AI's, so it's
 * always the same plain question: only the town or city is asked. Its chips are the AI's (the places
 * the story mentions first), or, when it gave none, the country's largest areas. A tapped chip is
 * saved as the case's town, as typing it would be. */
export function townQuestion(language: PlanLanguage, aiChips: string[] = []): QuestionPrompt {
  const korean = language === "ko";
  const chips = aiChips.length ? aiChips : korean ? ["서울", "경기도", "부산", "인천"] : ["Seoul", "Gyeonggi-do", "Busan", "Incheon"];
  return korean
    ? { question: "어느 도시나 지역에서 있었던 일인가요?", why: "가까운 변호사를 찾는 데 도움이 됩니다.", chips }
    : { question: "Which city or area did this happen in?", why: "It helps find a lawyer near you.", chips };
}

/** `prompt` as it may be shown in `language`: a question or why in another language becomes the
 * app's own (`fallback`); chips in another language are left out, and fewer than two left means the
 * app's chips. Null `fallback` (a follow-up has none) drops a wrong-language question instead. */
function inLanguage(prompt: QuestionPrompt, language: PlanLanguage, fallback: QuestionPrompt | null): QuestionPrompt | null {
  const wordsFit = fitsLanguage(prompt.question, language) && (!prompt.why || fitsLanguage(prompt.why, language));
  if (!wordsFit && !fallback) return null;
  const base = wordsFit ? prompt : fallback!;
  const chips = (wordsFit ? prompt.chips : []).filter((chip) => fitsLanguage(chip, language, "chip"));
  return { question: base.question, why: base.why, chips: chips.length >= 2 || !fallback ? chips : fallback.chips };
}

/** What each detail means, for the AI writing its question. */
const DETAIL_GUIDE: Record<QuestionDetail, string> = {
  place:
    "where it happened: the town or city. Only when the conversation doesn't already name one: if it does, drop this detail. The app words this question itself; give it 2 to 4 chips that are place names only (a city, province or district), starting with any the conversation mentions, then the most likely others. No follow-ups.",
  otherSide: "who the problem is with: the person, business or organisation on the other side.",
  relationship: "how the client is connected to the other side, and since when (for example employed there since a date, renting from them since a date, a customer under a contract made on a date).",
  terms: "the client's role or position and the money or contract terms involved (job and pay; rent and how long the tenancy is; the price or contract value). Amount chips use {currency}.",
  reasonGiven: "the reason the other side gave for what they did, as the client heard it.",
  status: "where things stand now: any contact or reply from the other side since, or anything the client has already done (a letter, a complaint, a claim).",
  witnesses: "whether anyone else saw or heard what happened, or can back it up.",
  goal: "what the client wants to happen.",
};

const CURRENCY: Record<TenantCode, string> = { UK: "pounds (£)", KR: "won (₩)", PH: "pesos (₱)" };

/** The conversation as the AI reads it, oldest first: the first client message (their story) in
 * full, later ones cut. */
export function conversationLines(messages: { role: string; content: string }[]): string {
  const kept = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim());
  const firstId = kept.findIndex((m) => m.role === "user");
  return kept
    .map((m, i) => `${m.role === "user" ? "Client" : "Assistant"}: ${m.content.trim().slice(0, i === firstId ? CLIENT_STORY_MAX_LENGTH : MESSAGE_MAX_CHARS)}`)
    .slice(-CONVERSATION_MAX_MESSAGES)
    .join("\n\n");
}

export function buildQuestionsPrompt(input: {
  tenantCode: TenantCode;
  /** The details to write questions for (the UK's place question is the app's own, never here). */
  details: QuestionDetail[];
  /** caseDetailsBlock's text. */
  caseDetails: string;
  conversation: string;
  today: string;
  /** The story's language: every question, why and chip is written in it. */
  language: PlanLanguage;
}): string {
  const currency = CURRENCY[input.tenantCode];
  const language = LANGUAGE_NAME[input.language];
  const list = input.details.map((d) => `- ${d}: ${DETAIL_GUIDE[d].replace("{currency}", currency)}`).join("\n");
  return `You are helping a client finish telling their legal problem, before a lawyer reads it. You are not giving legal advice and must not predict an outcome, name a law, or say what the client should do.

Today's date is ${input.today}.

${input.caseDetails}

The conversation so far (the client's first message is their story):
${input.conversation || "(none)"}

The case still needs these details. Write one question for each:
${list}

Write everything (every question, why, chip and follow-up) in ${language} only, because the client told their story in ${language}. Never use any other language or script, whatever the case details are written in.

For each question:
- question: one short question to the client, in plain everyday words, using what they already told you (their employer's or landlord's name, for example). Never ask two things at once.
- why: one short sentence saying why their lawyer needs this. Never a legal conclusion, a likely outcome, or advice.
- In the question and the why, never use legal terms (such as jurisdiction, liability, claimant, statute): say it the way the client would.
- chips: always 2 to 4 short likely answers (at most 5 words each) the client can tap, for every question. Never "I don't know", "Skip" or "Other": the screen has its own skip.
- followUps: only when a particular answer would leave the detail incomplete, one more question for it, keyed by that chip's exact text, or by "*" for any answer (for example the names after "Yes, co-workers"), with its own 2 to 4 chips. At most one level. {} when none is needed.

Drop a detail only when the conversation already answers it clearly, and list it under "dropped" with the reason. Never add a detail that isn't listed above.

Reply with only this JSON and nothing else:
{"questions": [{"detail": "witnesses", "question": "", "why": "", "chips": [""], "followUps": {"Yes, co-workers": {"question": "", "why": "", "chips": []}}}], "dropped": [{"detail": "", "because": ""}]}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Up to MAX_CHIPS short, different chips; an unusable list is simply none. */
function cleanChips(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const chips: string[] = [];
  for (const item of raw) {
    const chip = str(item);
    if (!chip || chip.length > CHIP_MAX_CHARS || chips.some((c) => c.toLowerCase() === chip.toLowerCase())) continue;
    chips.push(chip);
    if (chips.length === MAX_CHIPS) break;
  }
  return chips;
}

function cleanPrompt(raw: unknown): QuestionPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = str(r.question);
  if (!question || question.length > QUESTION_MAX_CHARS) return null;
  const why = str(r.why);
  return { question, why: why.length > WHY_MAX_CHARS ? "" : why, chips: cleanChips(r.chips) };
}

/**
 * Parses the AI's reply into questions for `details` (the ones it was asked for), in the fixed
 * order, every one in `language` and with chips: a question or why in another language is replaced
 * by the app's own (defaultPrompt), and chips missing, unusable or in another language become the
 * app's. One with no usable question text is left out. Follow-ups are kept only when keyed by one of
 * the question's own chips or "*", and in `language`. KR's place question never has follow-ups (its
 * wording and fallback chips are the service's). Null when the reply has no JSON, or neither a
 * question nor a dropped detail: nothing came of it.
 */
export function parseQuestionsReply(
  reply: string,
  { details, tenantCode, language = "en" }: { details: QuestionDetail[]; tenantCode: TenantCode; language?: PlanLanguage },
): Omit<QuestionPlan, "version"> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }

  const allowed = new Set<string>(details);
  const byDetail = new Map<QuestionDetail, PlannedQuestion>();
  for (const raw of Array.isArray(parsed.questions) ? parsed.questions : []) {
    if (!raw || typeof raw !== "object") continue;
    const detail = str((raw as Record<string, unknown>).detail) as QuestionDetail;
    if (!allowed.has(detail) || byDetail.has(detail)) continue;
    const written = cleanPrompt(raw);
    if (!written) continue;
    // Place has no app fallback here: outside the UK the service words it and fills its chips.
    const isPlace = detail === "place";
    const prompt = isPlace
      ? { ...written, chips: written.chips.filter((chip) => fitsLanguage(chip, language, "chip")) }
      : inLanguage(written, language, defaultPrompt(detail, language, tenantCode))!;
    const replaced = prompt.question !== written.question;
    const chips = prompt.chips;
    const followUps: Record<string, QuestionPrompt> = {};
    const rawFollowUps = (raw as Record<string, unknown>).followUps;
    // A town is the whole answer, so a place question never has follow-ups; nor does a question the
    // app had to reword, whose follow-ups hung off the AI's own chips.
    if (!isPlace && !replaced && rawFollowUps && typeof rawFollowUps === "object") {
      for (const [key, value] of Object.entries(rawFollowUps as Record<string, unknown>)) {
        const k = str(key);
        if (k !== "*" && !chips.includes(k)) continue;
        const follow = cleanPrompt(value);
        const fitted = follow ? inLanguage(follow, language, null) : null;
        if (fitted) followUps[k] = fitted;
      }
    }
    byDetail.set(detail, { id: detail, detail, question: prompt.question, why: prompt.why, chips, followUps, status: "OPEN", answer: null });
  }

  const dropped: QuestionPlan["dropped"] = [];
  for (const raw of Array.isArray(parsed.dropped) ? parsed.dropped : []) {
    if (!raw || typeof raw !== "object") continue;
    const detail = str((raw as Record<string, unknown>).detail) as QuestionDetail;
    if (!allowed.has(detail) || byDetail.has(detail) || dropped.some((d) => d.detail === detail)) continue;
    dropped.push({ detail, because: str((raw as Record<string, unknown>).because) });
  }

  if (!byDetail.size && !dropped.length) return null;
  const questions = QUESTION_DETAILS.filter((d) => byDetail.has(d)).map((d) => byDetail.get(d)!);
  return { questions, dropped };
}

/** A version stamp for a stored list's shape (QuestionPlan.version), so a later change can tell
 * an old list apart. */
export const QUESTION_PLAN_VERSION = 1 as const;
