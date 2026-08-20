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
 * Strips [TIMELINE]...[/TIMELINE] and [MINDMAP]...[/MINDMAP] blocks (closed or
 * left open by a streaming cutoff) from AI response text before it's stored/displayed.
 */
export function stripStructuredBlocks(text: string): string {
  let cleaned = text
    .replace(/\[TIMELINE\][\s\S]*?\[\/TIMELINE\]/gi, "")
    .replace(/\[MINDMAP\][\s\S]*?\[\/MINDMAP\]/gi, "")
    .replace(/\[STRUCTURED_DATA\][\s\S]*?(?:\[DONE\]|$)/gi, "")
    .replace(/\[DONE\]/gi, "");

  const startTags = [/\[TIMELINE\]/i, /\[MINDMAP\]/i];
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
