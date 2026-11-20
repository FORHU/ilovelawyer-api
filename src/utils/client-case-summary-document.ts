import type { CaseIntake, IntakeSource } from "../types/client-intake";
import type { TenantCode } from "../types/tenant-code";

/**
 * The client's "Case summary" (ilovelawyer-client#137): what the client told us about a case, as a
 * document they can keep or take to any lawyer. Built only from what the client entered or
 * uploaded and what the stored intake gathered from it — never the lawyer snapshot, and never an
 * assessment (ADR 0018): no strengths, weaknesses, strategy or outlook, no computed deadlines, no
 * chat transcript. The intake's neutral summary paragraph is in, labelled AI-written exactly as the
 * Overview labels it. Pure, so it can be tested without a PDF.
 */

export type SummaryLang = "en" | "ko";

export interface SummaryItem {
  text: string;
  /** For a dated section: the date as given ("12 March 2026", "April 2026", "Date not given"). */
  date?: string;
  /** A second line under the item: why a missing piece matters. */
  note?: string;
  /** Where it came from, ready to print ("Source: what you said in the chat"). */
  source?: string;
}

/** How a section is laid out: "callout" is set apart at the top (the stated deadlines), "dated"
 * has a date column (the timeline), "list" is plain bullets. */
export type SummarySectionKind = "callout" | "dated" | "list";

export interface SummarySection {
  kind: SummarySectionKind;
  title: string;
  items: SummaryItem[];
}

export interface CaseSummaryDocument {
  lang: SummaryLang;
  /** "Case summary" in the reader's language. */
  kicker: string;
  title: string;
  details: { label: string; value: string }[];
  /** The intake's AI-written summary, with the tag that says so ("AI-written · check it against
   * what you said"). Null when the intake has none. */
  aiSummary: { label: string; tag: string; text: string } | null;
  description: { label: string; text: string } | null;
  sections: SummarySection[];
  /** "As of 18 November 2026": when the intake was last saved. */
  asOf: string;
  disclaimer: string;
  /** "Page {n} of {total}", filled in per page by the renderer. */
  pageLabel: string;
}

export interface CaseSummaryInput {
  title: string;
  /** The case's areas by name, in the site's order. */
  areas: string[];
  ukJurisdiction: string | null;
  outsideUk: boolean;
  where: string;
  notes: string;
  /** Uploaded document names only — never the files. */
  documentNames: string[];
  intake: CaseIntake;
  tenantCode: TenantCode;
  lang: SummaryLang;
}

const LABELS = {
  en: {
    kicker: "Case summary",
    typeOfIssue: "Type of issue",
    partOfUk: "Part of the UK",
    outsideUk: "Outside the UK",
    notKnown: "Not known yet",
    where: "Where",
    summary: "Summary",
    aiWritten: "AI-written · check it against what you said",
    description: "In your words",
    people: "People and organisations involved",
    timeline: "Timeline",
    facts: "Facts",
    goals: "What you want",
    concerns: "Your concerns",
    questions: "Questions for a lawyer",
    deadlines: "Deadlines, as you stated them",
    missing: "Information still missing",
    conflicts: "Accounts that don't match",
    documents: "Documents you uploaded",
    asOf: (date: string) => `As of ${date}`,
    disclaimer: "Prepared from the information you gave us. It isn't legal advice.",
    dateNotGiven: "Date not given",
    pageLabel: "Page {n} of {total}",
    source: (where: string) => `Source: ${where}`,
    fromCaseDetails: "your case details",
    fromChat: "what you said in the chat",
    fromDocument: (name: string, page: number | null) => (page ? `${name}, page ${page}` : name),
    aDocument: "a document",
  },
  ko: {
    kicker: "사건 요약",
    typeOfIssue: "문제 유형",
    partOfUk: "영국 내 지역",
    outsideUk: "영국 외",
    notKnown: "아직 모름",
    where: "장소",
    summary: "요약",
    aiWritten: "AI 작성 · 말씀하신 내용과 맞는지 확인하세요",
    description: "직접 작성한 설명",
    people: "관련된 사람과 기관",
    timeline: "경과",
    facts: "사실관계",
    goals: "원하는 결과",
    concerns: "걱정되는 점",
    questions: "변호사에게 할 질문",
    deadlines: "직접 말씀하신 기한",
    missing: "아직 부족한 정보",
    conflicts: "서로 맞지 않는 내용",
    documents: "업로드한 문서",
    asOf: (date: string) => `${date} 기준`,
    disclaimer: "제공해 주신 정보로 작성했습니다. 법률 자문이 아닙니다.",
    dateNotGiven: "날짜 없음",
    pageLabel: "{total}쪽 중 {n}쪽",
    source: (where: string) => `출처: ${where}`,
    fromCaseDetails: "사건 정보",
    fromChat: "채팅에서 말씀하신 내용",
    fromDocument: (name: string, page: number | null) => (page ? `${name}, ${page}쪽` : name),
    aDocument: "문서",
  },
} as const;

type Labels = (typeof LABELS)[SummaryLang];

/** Each site's own day: the summary's dates read as the client's calendar shows them. */
const TIME_ZONES: Record<TenantCode, string> = { UK: "Europe/London", PH: "Asia/Manila", KR: "Asia/Seoul" };

const LOCALES: Record<SummaryLang, string> = { en: "en-GB", ko: "ko-KR" };

export function timeZoneOf(tenantCode: TenantCode): string {
  return TIME_ZONES[tenantCode] ?? "Europe/London";
}

/** A calendar date the intake holds (YYYY-MM-DD; a bare YYYY-MM or YYYY is accepted too), at the
 * precision it was given. Read in UTC so the day never shifts. Anything unreadable prints as given. */
function formatIntakeDate(date: string | null, precision: "DAY" | "MONTH" | "YEAR" | "UNKNOWN", lang: SummaryLang): string | null {
  if (!date || precision === "UNKNOWN") return null;
  const [year, month = "01", day = "01"] = date.slice(0, 10).split("-");
  const at = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  const opts: Intl.DateTimeFormatOptions =
    precision === "YEAR" ? { year: "numeric" } : precision === "MONTH" ? { year: "numeric", month: "long" } : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(LOCALES[lang], { ...opts, timeZone: "UTC" }).format(at);
}

/** An instant (generatedAt) as a day on the site's calendar. */
export function formatDayIn(at: Date, tenantCode: TenantCode, lang: SummaryLang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], { year: "numeric", month: "long", day: "numeric", timeZone: timeZoneOf(tenantCode) }).format(at);
}

function sourceLine(sources: IntakeSource[], l: Labels): string | undefined {
  const names = [
    ...new Set(
      sources.map((s) => (s.kind === "CASE_DETAILS" ? l.fromCaseDetails : s.kind === "CLIENT" ? l.fromChat : l.fromDocument(s.documentName ?? l.aDocument, s.page))),
    ),
  ];
  return names.length ? l.source(names.join("; ")) : undefined;
}

function ukRegion(input: CaseSummaryInput, l: Labels): string {
  if (input.ukJurisdiction) return input.ukJurisdiction;
  return input.outsideUk ? l.outsideUk : l.notKnown;
}

export function buildCaseSummaryDocument(input: CaseSummaryInput): CaseSummaryDocument {
  const l = LABELS[input.lang];
  const { intake } = input;

  const details: { label: string; value: string }[] = [];
  if (input.areas.length) details.push({ label: l.typeOfIssue, value: input.areas.join(", ") });
  // Only the UK site asks which part of the UK a case is in.
  if (input.tenantCode === "UK") details.push({ label: l.partOfUk, value: ukRegion(input, l) });
  if (input.where.trim()) details.push({ label: l.where, value: input.where.trim() });

  const plain = (items: { text: string; sources: IntakeSource[] }[]): SummaryItem[] => items.map((i) => ({ text: i.text, source: sourceLine(i.sources, l) }));

  // Deadlines first, set apart: the one thing a client or lawyer may have to act on soon.
  const sections: SummarySection[] = [
    {
      // Exactly as stated: the stated words, and the date only when one was given. Nothing computed.
      kind: "callout" as const,
      title: l.deadlines,
      items: intake.deadlines.map((d) => ({ text: d.text, date: formatIntakeDate(d.date, "DAY", input.lang) ?? l.dateNotGiven, source: sourceLine(d.sources, l) })),
    },
    {
      kind: "list" as const,
      title: l.people,
      items: intake.people.map((p) => ({ text: p.role && p.role !== p.name ? `${p.name} — ${p.role}` : p.name, source: sourceLine(p.sources, l) })),
    },
    {
      kind: "dated" as const,
      title: l.timeline,
      items: intake.timeline.map((e) => ({ text: e.text, date: formatIntakeDate(e.date, e.datePrecision, input.lang) ?? l.dateNotGiven, source: sourceLine(e.sources, l) })),
    },
    { kind: "list" as const, title: l.facts, items: plain(intake.facts) },
    { kind: "list" as const, title: l.goals, items: plain(intake.goals) },
    { kind: "list" as const, title: l.concerns, items: plain(intake.concerns) },
    { kind: "list" as const, title: l.questions, items: plain(intake.questionsForLawyer) },
    { kind: "list" as const, title: l.missing, items: intake.missing.map((m) => ({ text: m.question, note: m.why || undefined })) },
    { kind: "list" as const, title: l.conflicts, items: intake.conflicts.map((c) => ({ text: c.description, source: sourceLine(c.sources, l) })) },
    { kind: "list" as const, title: l.documents, items: input.documentNames.map((name) => ({ text: name })) },
  ].filter((s) => s.items.length > 0);

  return {
    lang: input.lang,
    kicker: l.kicker,
    title: input.title,
    details,
    aiSummary: intake.summary?.trim() ? { label: l.summary, tag: l.aiWritten, text: intake.summary.trim() } : null,
    description: input.notes.trim() ? { label: l.description, text: input.notes.trim() } : null,
    sections,
    asOf: l.asOf(intake.generatedAt ? formatDayIn(new Date(intake.generatedAt), input.tenantCode, input.lang) : "—"),
    disclaimer: l.disclaimer,
    pageLabel: l.pageLabel,
  };
}

/** case-summary-<title>-<YYYY-MM-DD>.pdf, the date on the site's calendar. Letters and digits of any
 * script stay (a Korean title is still readable; the header carries it as UTF-8); everything else,
 * path separators included, becomes a dash. The same rule as ilovelawyer-client's caseSummaryFilename. */
export function caseSummaryFilename(title: string, now: Date, tenantCode: TenantCode): string {
  const slug =
    title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "case";
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timeZoneOf(tenantCode) }).format(now);
  return `case-summary-${slug}-${day}.pdf`;
}
