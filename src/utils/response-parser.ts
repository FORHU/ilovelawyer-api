// Ported from law-ph's lib/citation-parser.ts — extracts the [TIMELINE] / [MINDMAP]
// structured-data blocks Chat Wonder embeds in AI response text, and strips them
// from the text before it's persisted/displayed as a chat message.

export interface TimelineItem {
  title: string;
  date?: string;
  description: string;
  status: "completed" | "pending" | "active";
}

export interface MindMapItem {
  id: string;
  label: string;
  description?: string;
  isRoot?: boolean;
  children: MindMapItem[];
}

export interface AudioOverviewTurn {
  speaker: "HOST_A" | "HOST_B";
  text: string;
}

export interface CitationReason {
  title: string;
  why_cited: string;
}

export interface ReasoningExplanation {
  reasoning: string;
  citation_reasons: CitationReason[];
}

export interface TopicSection {
  title: string;
  content: string;
}

/**
 * Extracts a timeline from AI responses.
 * Supports: [TIMELINE]...[/TIMELINE] JSON wrapper, an unclosed tag (streaming cutoff),
 * and a bare JSON array fallback.
 */
export function extractTimeline(text: string): TimelineItem[] | undefined {
  const timelineRegex = /\[TIMELINE\]([\s\S]*?)\[\/TIMELINE\]/i;
  const match = text.match(timelineRegex);

  let jsonStr = "";
  if (match) {
    jsonStr = match[1].trim();
  } else {
    const openTagRegex = /\[TIMELINE\]([\s\S]*?)(?:\[MINDMAP\]|\[ILM_META\]|$)/i;
    const openMatch = text.match(openTagRegex);
    if (openMatch) {
      jsonStr = openMatch[1].trim();
    } else {
      const fallbackMatch = text.match(/(\[\s*\{\s*"title"\s*:[\s\S]*?\}\s*\])/i);
      if (fallbackMatch) jsonStr = fallbackMatch[1].trim();
    }
  }

  if (!jsonStr) return undefined;

  const parsed = safeJsonParse(jsonStr.replace(/^﻿/, ""));
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed as TimelineItem[];
  }

  return undefined;
}

function isMindMapShape(v: unknown): v is MindMapItem {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const anyV: any = v;
  return Boolean(anyV.id || anyV.nodes || anyV.label || anyV.children);
}

/** Unwraps Chat Wonder / LLM wrappers (`mindMap`, `root`) down to a renderable tree. */
export function normalizeMindMap(v: unknown): MindMapItem | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const anyV: any = v;
  const nested = anyV.mindMap ?? anyV.mindmap ?? anyV.mind_map;
  const tree =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested
      : anyV.root && typeof anyV.root === "object" && !Array.isArray(anyV.root) &&
          (anyV.root.label || anyV.root.id || anyV.root.children)
        ? anyV.root
        : anyV;
  if (!isMindMapShape(tree)) return undefined;
  return tree as MindMapItem;
}

/**
 * Chat Wonder legal persona emits `[STRUCTURED_DATA]{"timeline":[...],"mindMap":{...}}`
 * after `__END__` (see chat-wonder-v2-api `_generate_structured_data`). Not the older
 * `[MINDMAP]...[/MINDMAP]` inline tags.
 */
export function parseStructuredDataPayload(raw: string): {
  timeline?: TimelineItem[];
  mindMap?: MindMapItem;
} {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const anyV = parsed as any;
  const timeline =
    Array.isArray(anyV.timeline) && anyV.timeline.length > 0
      ? (anyV.timeline as TimelineItem[])
      : undefined;

  const nested = anyV.mindMap ?? anyV.mindmap ?? anyV.mind_map;
  const mindMap = nested ? normalizeMindMap(nested) : normalizeMindMap(parsed);
  return { timeline, mindMap };
}

/**
 * Chat Wonder's dedicated `[AUDIO_OVERVIEW_DATA]{"turns":[...]}` frame (the_server.py's
 * `_generate_audio_overview_script`, gated by `_wants_audio_overview` — only sent when the
 * hidden Audio Overview trigger message asked for it, unlike STRUCTURED_DATA which is
 * unconditional). Always its own clean frame, never inline-embedded in the streamed answer
 * text the way [MINDMAP]/[TIMELINE] are, so — unlike extractMindMap below — this doesn't need
 * to tolerate a streaming-cutoff partial tag.
 */
export function parseAudioOverviewPayload(raw: string): AudioOverviewTurn[] | undefined {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const turns = (parsed as { turns?: unknown }).turns;
  if (!Array.isArray(turns) || turns.length === 0) return undefined;
  const valid = turns.filter((t): t is AudioOverviewTurn => {
    const anyT: any = t;
    return (
      !!anyT &&
      typeof anyT === "object" &&
      (anyT.speaker === "HOST_A" || anyT.speaker === "HOST_B") &&
      typeof anyT.text === "string" &&
      anyT.text.trim().length > 0
    );
  });
  return valid.length > 0 ? valid : undefined;
}

/**
 * Splits a finished, cleaned assistant reply into topic sections for MessageGroup — purely
 * local text parsing, no AI call and no chat-wonder involvement (that path was tried and
 * dropped; see the MessageGroup handoff notes). Uses the reply's own markdown headings as
 * topic boundaries, the same way a human would skim it: prefer top-level (`# `) headings when
 * there are at least two of them (a multi-topic overview, each topic getting its own `#`);
 * otherwise fall back to second-level (`## `) headings when there are at least two of *those*
 * (a single-topic answer broken into `##` subsections, e.g. "Case overview" with several
 * `## `-headed parts) — never both levels at once, or a document that nests `##` subsections
 * *inside* each `#` topic would get shredded into one bubble per subsection instead of per
 * topic. Returns undefined (no split) for anything without a clear multi-section structure,
 * which is the normal case for a short or single-topic answer.
 */
export function splitIntoTopics(content: string): TopicSection[] | undefined {
  const h1Count = (content.match(/^#\s+.+$/gm) || []).length;
  const level = h1Count >= 2 ? 1 : (content.match(/^##\s+.+$/gm) || []).length >= 2 ? 2 : 0;
  if (level === 0) return undefined;

  const splitPoint = level === 1 ? /\n(?=#\s+)/g : /\n(?=##\s+)/g;

  const sections = content
    .split(splitPoint)
    .map((section) => section.trim())
    .filter(Boolean);
  if (sections.length < 2) return undefined;

  // Matches either level for the TITLE specifically (not the split-boundary regex above):
  // when splitting on `##`, the first section still opens with the document's lone `#` title
  // rather than a `##` line, and should show that as its title, not the "Topic N" fallback.
  const headingLine = /^#{1,2}\s+(.+)$/m;

  return sections.map((section, index) => {
    const headingMatch = section.match(headingLine);
    const title = headingMatch?.[1]?.replace(/\*\*/g, "").trim() || `Topic ${index + 1}`;
    return { title, content: section };
  });
}

/**
 * Chat Wonder's `{"type":"reasoning","session_id":...,"data":{...}}` typed WebSocket
 * message (see chat-wonder-v2-api's `_generate_reasoning_explanation` /
 * docs/handoffs/handoff-legal-reasoning-trace-integration-2026-08-28.md). Unlike
 * STRUCTURED_DATA/AUDIO_OVERVIEW_DATA, this isn't a `[TAG]`-prefixed string frame — the
 * whole WebSocket message is valid JSON on its own, so the caller passes the already-
 * parsed `.data` field here, not a raw string to extract from.
 */
export function parseReasoningPayload(data: unknown): ReasoningExplanation | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const anyV = data as any;
  if (typeof anyV.reasoning !== "string" || !anyV.reasoning.trim()) return undefined;
  const citation_reasons: CitationReason[] = Array.isArray(anyV.citation_reasons)
    ? anyV.citation_reasons.filter(
        (c: any): c is CitationReason =>
          !!c && typeof c === "object" && typeof c.title === "string" && typeof c.why_cited === "string",
      )
    : [];
  return { reasoning: anyV.reasoning, citation_reasons };
}

// Decision Records (differentiation program, Phase 1) — the "Why?" behind one conclusion in a
// legal answer, already verified by chat-wonder-v2-api's legal_decisions.py before it ever
// reaches here (every rule link checked against the retrieved pool, every evidence reference
// checked against the attached exhibits) — see docs/plans/differentiation-program.md
// Workstream A. This app only re-validates shape, not content: it never re-derives `verified`.
export interface DecisionRule {
  title: string;
  url: string | null;
  verified: boolean;
}

export interface DecisionEvidence {
  doc: string;
  docId: string | null;
  pinpoint: string;
  quote: string | null;
  verified: boolean;
}

export interface DecisionAlternative {
  position: string;
  whyRejected: string;
  evidenceRef: string | null;
}

export interface DecisionRecordItem {
  anchor: string;
  conclusion: string;
  rule: DecisionRule[];
  evidenceFor: DecisionEvidence[];
  evidenceAgainst: DecisionEvidence[];
  alternatives: DecisionAlternative[];
  weighting: string;
  confidence: "high" | "medium" | "low";
  wouldChangeIf: string[];
}

export interface DecisionRecordsPayload {
  records: DecisionRecordItem[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asDecisionEvidence(v: unknown): DecisionEvidence[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      doc: typeof e.doc === "string" ? e.doc : "",
      docId: typeof e.docId === "string" ? e.docId : null,
      pinpoint: typeof e.pinpoint === "string" ? e.pinpoint : "",
      quote: typeof e.quote === "string" ? e.quote : null,
      verified: e.verified === true,
    }));
}

/** Same calling convention as parseReasoningPayload: the whole `{"type":"decisions",...}`
 * WebSocket message is valid JSON on its own, so the caller passes the parsed `.data` field. */
export function parseDecisionsPayload(data: unknown): DecisionRecordsPayload | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const anyV = data as any;
  if (!Array.isArray(anyV.records)) return undefined;
  const records: DecisionRecordItem[] = anyV.records
    .filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter((r: Record<string, unknown>) => typeof r.anchor === "string" && r.anchor.trim() && typeof r.conclusion === "string")
    .map((r: Record<string, unknown>) => ({
      anchor: r.anchor as string,
      conclusion: r.conclusion as string,
      rule: Array.isArray(r.rule)
        ? (r.rule as any[])
            .filter((x) => !!x && typeof x === "object" && typeof x.title === "string")
            .map((x) => ({ title: x.title as string, url: typeof x.url === "string" ? x.url : null, verified: x.verified === true }))
        : [],
      evidenceFor: asDecisionEvidence(r.evidenceFor),
      evidenceAgainst: asDecisionEvidence(r.evidenceAgainst),
      alternatives: Array.isArray(r.alternatives)
        ? (r.alternatives as unknown[])
            .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
            .map((x) => ({
              position: typeof x.position === "string" ? x.position : "",
              whyRejected: typeof x.whyRejected === "string" ? x.whyRejected : "",
              evidenceRef: typeof x.evidenceRef === "string" ? x.evidenceRef : null,
            }))
        : [],
      weighting: typeof r.weighting === "string" ? r.weighting : "",
      confidence: r.confidence === "high" || r.confidence === "low" ? r.confidence : "medium",
      wouldChangeIf: asStringArray(r.wouldChangeIf),
    }));
  if (!records.length) return undefined;
  return { records };
}

/**
 * Extracts a mind map structure from AI responses.
 * Supports [MINDMAP]...[/MINDMAP] wrapper, an unclosed tag (streaming cutoff),
 * and a bare JSON object fallback.
 */
export function extractMindMap(text: string): MindMapItem | undefined {
  const mindMapRegex = /\[MINDMAP\]([\s\S]*?)\[\/MINDMAP\]/i;
  const match = text.match(mindMapRegex);

  let jsonStr = "";
  if (match) {
    jsonStr = match[1].trim();
  } else {
    const openTagRegex = /\[MINDMAP\]([\s\S]*?)(?:\[TIMELINE\]|\[ILM_META\]|$)/i;
    const openMatch = text.match(openTagRegex);
    if (openMatch) {
      jsonStr = openMatch[1].trim();
    } else {
      const blocks = text.split(/[\r\n]{2,}/);
      for (const block of blocks.reverse()) {
        if (block.includes('"id"') && block.includes('"root"')) {
          const fallbackMatch = block.match(/(\{[\s\S]*\})/);
          if (fallbackMatch) {
            jsonStr = fallbackMatch[1].trim();
            break;
          }
        }
      }
    }
  }

  if (!jsonStr) return undefined;

  const cleaned = jsonStr
    .replace(/^﻿/, "")
    .replace(/^```json\s*/i, "")
    .replace(/```$/, "")
    .trim();

  const parsed = safeJsonParse(cleaned);
  return normalizeMindMap(parsed);
}

/**
 * Chat Wonder tagged JSON. Used by contradiction scan and other REST extracts
 * that are not TIMELINE/MINDMAP-shaped.
 */
export function parseAiJson(str: string): unknown {
  return safeJsonParse(str);
}

/**
 * Strips [TIMELINE]...[/TIMELINE], [MINDMAP]...[/MINDMAP], and [TRACE]...[/TRACE] blocks
 * (closed or left open by a streaming cutoff) from AI response text before it's stored/
 * displayed. [TRACE] frames (the_server.py's glass-box research-step events — see
 * streaming_run_function_chain) are forwarded to the client as plain chunks the same way
 * [TIMELINE]/[MINDMAP] are — chatWonder.ts has no special handling for them either, they're
 * purely a display-layer concern — so without stripping them here, raw trace JSON gets baked
 * into the persisted Message.content forever (the live-streaming bubble already strips them
 * via mind-map-parser.ts's own copy of this function; this is what keeps the *saved* copy
 * clean once the turn settles and the transcript re-renders from history instead).
 */
export function stripStructuredBlocks(text: string): string {
  let cleaned = text
    .replace(/\[TIMELINE\][\s\S]*?\[\/TIMELINE\]/gi, "")
    .replace(/\[MINDMAP\][\s\S]*?\[\/MINDMAP\]/gi, "")
    .replace(/\[TRACE\][\s\S]*?\[\/TRACE\]/gi, "")
    .replace(/\[STRUCTURED_DATA\][\s\S]*?(?:\[DONE\]|$)/gi, "")
    .replace(/\[DONE\]/gi, "");

  const startTags = [/\[TIMELINE\]/i, /\[MINDMAP\]/i, /\[TRACE\]/i];
  let firstTagIdx = -1;
  for (const tag of startTags) {
    const idx = cleaned.search(tag);
    if (idx !== -1 && (firstTagIdx === -1 || idx < firstTagIdx)) firstTagIdx = idx;
  }
  if (firstTagIdx !== -1) cleaned = cleaned.substring(0, firstTagIdx);

  return cleaned.trim();
}

/**
 * Robustly parses a JSON string that may contain unescaped control characters
 * or minor syntax slips from AI-generated content. Returns null on failure.
 */
function safeJsonParse(str: string): any {
  if (!str) return null;

  try {
    const firstBrace = str.indexOf("{");
    const firstBracket = str.indexOf("[");
    const start = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket) ? firstBrace : firstBracket;

    const lastBrace = str.lastIndexOf("}");
    const lastBracket = str.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);

    let jsonPart = str;
    if (start !== -1 && end !== -1 && end > start) {
      jsonPart = str.substring(start, end + 1);
    }

    let sanitized = jsonPart
      .trim()
      .replace(/^﻿/, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1");

    sanitized = sanitized
      .replace(/\}\s*\{/g, "}, {")
      .replace(/\]\s*\[/g, "], [");

    try {
      return JSON.parse(sanitized);
    } catch {
      let processed = "";
      let inQuote = false;
      let escaped = false;

      for (let i = 0; i < sanitized.length; i++) {
        const char = sanitized[i];

        if (char === '"' && !escaped) {
          if (inQuote) {
            let nextChar = "";
            for (let j = i + 1; j < sanitized.length; j++) {
              if (!/\s/.test(sanitized[j])) {
                nextChar = sanitized[j];
                break;
              }
            }
            if (nextChar && ![":", ",", "}", "]"].includes(nextChar)) {
              processed += '\\"';
              continue;
            }
          }
          inQuote = !inQuote;
          processed += char;
        } else if (inQuote && !escaped) {
          if (char === "\n") processed += "\\n";
          else if (char === "\r") processed += "\\r";
          else if (char === "\t") processed += "\\t";
          else if (char === "\\") {
            escaped = true;
            processed += char;
          } else {
            const code = char.charCodeAt(0);
            if (code >= 32) processed += char;
          }
        } else {
          if (escaped) escaped = false;
          processed += char;
        }
      }

      processed = processed
        .replace(/\}\s*\{/g, "}, {")
        .replace(/\]\s*\[/g, "], [")
        .replace(/\}\s*\[/g, "}, [")
        .replace(/\]\s*\{/g, "], {");

      try {
        return JSON.parse(processed);
      } catch {
        let finalAttempt = processed.trim().replace(/,\s*$/, "");

        let isStringOpen = false;
        let isEscape = false;
        const stack: string[] = [];

        for (let i = 0; i < finalAttempt.length; i++) {
          const char = finalAttempt[i];
          if (isEscape) {
            isEscape = false;
            continue;
          }
          if (char === "\\") {
            isEscape = true;
            continue;
          }
          if (char === '"') {
            isStringOpen = !isStringOpen;
            continue;
          }
          if (!isStringOpen) {
            if (char === "{") stack.push("}");
            else if (char === "[") stack.push("]");
            else if (char === "}" || char === "]") {
              if (stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
            }
          }
        }

        if (isStringOpen) finalAttempt += '"';
        while (stack.length > 0) finalAttempt += stack.pop();

        finalAttempt = finalAttempt
          .trim()
          .replace(/,\s*$/, "")
          .replace(/:\s*$/, "")
          .replace(/,\s*"\w*"\s*$/, "")
          .replace(/\{\s*"\w*"\s*$/, "{");

        try {
          return JSON.parse(finalAttempt);
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }
}
