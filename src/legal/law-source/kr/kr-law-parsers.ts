import { Prisma } from "@prisma/client";
import { KR_LAW_ID_PREFIX, KR_PRECEDENT_ID_PREFIX, krLawUrl, krPrecedentUrl } from "./kr-law-vocab";

// The Korean Law MCP answers every tool with formatted Korean text (no JSON), in a fixed layout per
// tool. These turn that text into Library rows. Pure functions, tested against real answers in
// test/fixtures/kr-law. A layout change upstream shows up here as empty results, never a crash.

/** One statute from `search_law`. */
export interface KrLawHit {
  title: string;
  lawId: string;
  mst: string;
  /** 법률, 대통령령, 고용노동부령 … */
  kind: string | null;
  /** YYYYMMDD. */
  promulgatedOn: string | null;
  effectiveOn: string | null;
  /** "현행" for the version in force. */
  status: string | null;
}

/** One decision from `search_decisions` (precedent). */
export interface KrDecisionHit {
  id: string;
  title: string;
  caseNumber: string | null;
  court: string | null;
  /** YYYYMMDD. */
  decidedOn: string | null;
  /** 판결, 결정 … */
  decisionType: string | null;
}

export interface KrDecisionSearch {
  total: number;
  hits: KrDecisionHit[];
}

/** One decision from `get_decision_text`, by section. */
export interface KrDecisionText {
  title: string | null;
  caseNumber: string | null;
  court: string | null;
  decidedOn: string | null;
  caseKind: string | null;
  decisionType: string | null;
  /** 판시사항: the questions the decision answers, one per [n]. */
  issues: string[];
  /** 판결요지: the holdings. */
  holdings: string | null;
  /** 참조조문, one per [n] or "/" group. */
  referencedProvisions: string[];
  /** 참조판례. */
  referencedCases: string[];
  /** 주문: the order, from the full text. */
  order: string | null;
  /** 전문: the full judgment. */
  fullText: string | null;
}

/** One statute's table of contents from `get_law_text` (no `jo`). */
export interface KrLawToc {
  title: string | null;
  promulgatedOn: string | null;
  effectiveOn: string | null;
  /** "제23조", "제100조의2" … in order. */
  articles: { jo: string; heading: string }[];
}

const NOISE = /^(?:💡|🔜|ℹ️|⚠️|📍|📂)/u;

const field = (block: string, label: string): string | null => {
  const m = block.match(new RegExp(`${label}:\\s*([^\\n]+)`));
  const value = m?.[1]?.trim();
  return value && value !== "N/A" ? value : null;
};

const ymd = (raw: string | null): string | null => (raw && /^\d{8}$/.test(raw) ? raw : null);

/** "20260813" -> a UTC date. */
export function dateFromYmd(raw: string | null): Date | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const d = new Date(Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "20260813" -> "2026.08.13", the way Korean legal texts write dates. */
export function dotDate(raw: string | null): string | null {
  return raw && /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}.${raw.slice(4, 6)}.${raw.slice(6, 8)}` : null;
}

export function parseLawSearch(text: string): KrLawHit[] {
  const hits: KrLawHit[] = [];
  // "1. 근로기준법 [현행]\n   - 법령ID: …\n   - MST: …\n   - 공포일: … / 시행일: …\n   - 구분: 법률"
  const entry = /^\d+\.\s+(.+?)(?:\s+\[([^\]]+)\])?\s*\n((?:\s+-\s+[^\n]*\n?)+)/gm;
  for (const m of text.matchAll(entry)) {
    const body = m[3]!;
    const mst = field(body, "MST");
    const lawId = field(body, "법령ID");
    if (!mst || !lawId) continue;
    hits.push({
      title: m[1]!.trim(),
      status: m[2]?.trim() ?? null,
      lawId,
      mst,
      kind: field(body, "구분"),
      promulgatedOn: ymd(body.match(/공포일:\s*(\d{8})/)?.[1] ?? null),
      effectiveOn: ymd(body.match(/시행일:\s*(\d{8})/)?.[1] ?? null),
    });
  }
  return hits;
}

export function parseDecisionSearch(text: string): KrDecisionSearch {
  const total = Number(text.match(/총\s*([\d,]+)\s*건/)?.[1]?.replace(/,/g, "") ?? 0);
  const hits: KrDecisionHit[] = [];
  // "[616245] 부당해고구제재심판정취소\n  사건번호: …\n  법원: …\n  선고일: …\n  판결유형: …"
  const entry = /^\[(\d+)\]\s+(.+)\n((?:[ \t]+[^\n]*\n?)+)/gm;
  for (const m of text.matchAll(entry)) {
    const body = m[3]!;
    hits.push({
      id: m[1]!,
      title: m[2]!.trim(),
      caseNumber: field(body, "사건번호"),
      court: field(body, "법원"),
      decidedOn: ymd(field(body, "선고일")),
      decisionType: field(body, "판결유형"),
    });
  }
  return { total: Number.isFinite(total) ? total : hits.length, hits };
}

/** The decision's sections, keyed by their heading line ("판시사항:"). */
function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const heading = /^([가-힣 ]{2,8}):\s*$/gm;
  const marks = [...text.matchAll(heading)].map((m) => ({ name: m[1]!.trim(), start: m.index!, bodyStart: m.index! + m[0].length }));
  marks.forEach((mark, i) => {
    const body = text.slice(mark.bodyStart, marks[i + 1]?.start ?? text.length).trim();
    // "전문:" is printed twice; keep the one with the text.
    if (!sections.has(mark.name) || body.length > (sections.get(mark.name)?.length ?? 0)) sections.set(mark.name, body);
  });
  return sections;
}

/** "[1] … \n\n[2] …" -> ["…", "…"]; text with no [n] markers is one item. */
function numbered(body: string | undefined): string[] {
  if (!body?.trim()) return [];
  // "[1] A / [2] B": the separator before a marker belongs to neither item.
  return body
    .split(/(?:^|\s)\[\d+\]\s*/)
    .map((s) => s.replace(/\s+/g, " ").replace(/[\s/,;]+$/, "").trim())
    .filter(Boolean);
}

const unique = (items: string[]) => [...new Set(items.map((s) => s.trim()).filter(Boolean))];

export function parseDecisionText(text: string): KrDecisionText {
  const sections = sectionsOf(text);
  const basic = sections.get("기본 정보") ?? "";
  const full = sections.get("전문")?.replace(/^전문:\s*/gm, "").trim() || null;
  // 【주 문】 … up to the next 【…】 heading.
  const order = full?.match(/【\s*주\s*문\s*】\s*([\s\S]*?)(?=\n?【|$)/)?.[1]?.trim() || null;
  return {
    title: text.match(/^===\s*(.+?)\s*===/m)?.[1]?.trim() ?? null,
    caseNumber: field(basic, "사건번호"),
    court: field(basic, "법원"),
    decidedOn: ymd(field(basic, "선고일")),
    caseKind: field(basic, "사건종류"),
    decisionType: field(basic, "판결유형"),
    issues: numbered(sections.get("판시사항")),
    holdings: sections.get("판결요지")?.trim() || null,
    referencedProvisions: unique(numbered(sections.get("참조조문")).flatMap((s) => s.split(/\s+\/\s+/))),
    referencedCases: unique(numbered(sections.get("참조판례")).flatMap((s) => s.split(/,\s*(?=대법원|헌법재판소|[가-힣]+(?:고등|지방|행정|가정|특허)법원)/))),
    order,
    fullText: full,
  };
}

export function parseLawToc(text: string): KrLawToc {
  const articles: { jo: string; heading: string }[] = [];
  const tocStart = text.search(/^목차/m);
  if (tocStart >= 0) {
    for (const line of text.slice(tocStart).split("\n")) {
      const m = line.trim().match(/^(제\d+조(?:의\d+)?)(?:\s+(.*))?$/);
      if (m) articles.push({ jo: m[1]!, heading: (m[2] ?? "").trim() });
    }
  }
  return {
    title: field(text, "법령명"),
    promulgatedOn: ymd(field(text, "공포일")),
    effectiveOn: ymd(field(text, "시행일")),
    articles,
  };
}

/**
 * `get_batch_articles` text -> the articles' text: the law's name line goes, and an article's short
 * heading ("제2조 정의") goes when the article's own first line repeats it ("제2조(정의)").
 */
export function cleanBatchArticles(text: string, lawTitle: string | null): string {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lawTitle && lines[0]?.trim() === lawTitle) lines.shift();
  const out: string[] = [];
  lines.forEach((line, i) => {
    const short = line.trim().match(/^(제\d+조(?:의\d+)?)\s+\S/);
    if (short && lines[i + 1]?.trim().startsWith(`${short[1]}(`)) return;
    if (NOISE.test(line.trim())) return;
    out.push(line);
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── to Law rows ─────────────────────────────────────────────────────────────

export function lawHitToCreateInput(hit: KrLawHit, tenantId: string): Prisma.LawCreateManyInput {
  const url = krLawUrl(hit.mst);
  const dates = [hit.promulgatedOn && `공포 ${dotDate(hit.promulgatedOn)}`, hit.effectiveOn && `시행 ${dotDate(hit.effectiveOn)}`].filter(Boolean);
  return {
    jurisSourceId: `${KR_LAW_ID_PREFIX}${hit.mst}`,
    category: "REPUBLIC_ACT",
    tenantId,
    title: hit.title,
    year: hit.effectiveOn ? +hit.effectiveOn.slice(0, 4) : hit.promulgatedOn ? +hit.promulgatedOn.slice(0, 4) : null,
    tags: hit.status ? [hit.status] : [],
    // The law's kind (법률/대통령령/…) is the badge a statute card shows.
    raNumber: hit.kind,
    summary: dates.length ? dates.join(" · ") : null,
    jurisUrl: url,
    sourceUrl: url,
    pdfUrl: null,
    rawJson: hit as unknown as Prisma.InputJsonValue,
  };
}

export function decisionHitToCreateInput(hit: KrDecisionHit, tenantId: string): Prisma.LawCreateManyInput {
  const url = krPrecedentUrl(hit.id);
  const decided = dateFromYmd(hit.decidedOn);
  return {
    jurisSourceId: `${KR_PRECEDENT_ID_PREFIX}${hit.id}`,
    category: "JURISPRUDENCE",
    tenantId,
    title: hit.title || "(제목 없음)",
    year: decided ? decided.getUTCFullYear() : null,
    tags: [],
    caseNumber: hit.caseNumber,
    division: hit.court,
    caseType: hit.decisionType,
    decisionDate: decided,
    jurisUrl: url,
    sourceUrl: url,
    pdfUrl: null,
    rawJson: hit as unknown as Prisma.InputJsonValue,
  };
}

const SUMMARY_MAX = 600;

export function decisionDetailInput(d: KrDecisionText): Prisma.LawUpdateInput {
  return {
    detailFetchedAt: new Date(),
    keywords: [],
    ...(d.caseKind ? { caseType: d.caseKind } : {}),
    // 판결요지 is what a card's snippet and the citation hover show.
    summary: d.holdings ? (d.holdings.length > SUMMARY_MAX ? `${d.holdings.slice(0, SUMMARY_MAX).trimEnd()}…` : d.holdings) : null,
    legalIssues: d.issues,
    courtReasoning: d.holdings,
    disposition: d.order,
    legalRulesCited: d.referencedProvisions,
    relatedCasesCited: d.referencedCases,
    fullText: d.fullText,
    fullTextFetchedAt: new Date(),
  };
}

export function lawDetailInput(toc: KrLawToc, fullText: string | null): Prisma.LawUpdateInput {
  return {
    detailFetchedAt: new Date(),
    keywords: [],
    dateEnacted: dotDate(toc.effectiveOn),
    // The article list only when there's no text to read: with it, the text already holds every
    // heading, and a long code's list (민법: over 1,100 articles) would bury the page.
    ...(fullText ? {} : { sections: toc.articles.map((a) => ({ title: [a.jo, a.heading].filter(Boolean).join(" "), summary: null })) as unknown as Prisma.InputJsonValue }),
    fullText,
    fullTextFetchedAt: new Date(),
  };
}
