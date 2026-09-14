import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

const MAX_SCENES = 20;
const MAX_ACTORS = 10;
const MAX_DIALOGUE_LINES = 20;
const MAX_SOURCE_REFS = 8;
const MAX_UNRESOLVED = 8;
const MAX_TEXT_CHARS = 400;
const MAX_QUOTE_CHARS = 300;
const CONFIDENCES = ["high", "medium", "low"] as const;

export interface SceneDialogueLine {
  actor: string;
  line: string;
}

export interface SceneSourceRef {
  docId: string;
  page: number | null;
  quote: string | null;
  /** Set by auditScenes, never by the model itself — docId resolves to a real case document
   * and, if a quote was given, it actually appears in that document's sampled text. */
  verified: boolean;
}

export interface Scene {
  index: number;
  time: string;
  location: string;
  actors: string[];
  action: string;
  dialogue: SceneDialogueLine[];
  sourceRefs: SceneSourceRef[];
  confidence: (typeof CONFIDENCES)[number];
  unresolved: string[];
}

function trimmedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, maxLen);
  return trimmed || undefined;
}

function stringArray(value: unknown, maxLen: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = trimmedString(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export type RawScene = Omit<Scene, "sourceRefs"> & { rawSourceRefs: unknown };

/** Extracts and shape-validates the [SCENES] block into raw, unverified scenes — no docId/quote
 * checking here (see auditScenes for that). `undefined` = the tag is missing/unparseable, which
 * CaseReconstructionSvc.generateScenes treats as "chat-wonder returned nothing usable" rather
 * than persisting an empty script. */
export function parseRawScenes(text: string): RawScene[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closedRe = /\[SCENES\]([\s\S]*?)\[\/SCENES\]/i;
  const closed = cleaned.match(closedRe);
  const openRe = /\[SCENES\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i;
  const tagContent = closed ? closed[1] : cleaned.match(openRe)?.[1];
  if (!tagContent) return undefined;

  const jsonStr = tagContent.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const scenes: RawScene[] = [];
  let autoIndex = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const time = trimmedString(r.time, 120) ?? "";
    const location = trimmedString(r.location, 160) ?? "";
    const action = trimmedString(r.action, MAX_TEXT_CHARS);
    if (!action) continue; // an action-less scene has nothing to render or verify

    const actors = stringArray(r.actors, 80, MAX_ACTORS);

    const dialogue: SceneDialogueLine[] = [];
    if (Array.isArray(r.dialogue)) {
      for (const d of r.dialogue) {
        if (!d || typeof d !== "object") continue;
        const dr = d as Record<string, unknown>;
        const actor = trimmedString(dr.actor, 80);
        const line = trimmedString(dr.line, MAX_TEXT_CHARS);
        if (!actor || !line) continue;
        dialogue.push({ actor, line });
        if (dialogue.length >= MAX_DIALOGUE_LINES) break;
      }
    }

    const confidence = CONFIDENCES.includes(r.confidence as (typeof CONFIDENCES)[number])
      ? (r.confidence as (typeof CONFIDENCES)[number])
      : "medium";
    const unresolved = stringArray(r.unresolved, 200, MAX_UNRESOLVED);

    scenes.push({
      index: typeof r.index === "number" ? r.index : autoIndex,
      time,
      location,
      actors,
      action,
      dialogue,
      confidence,
      unresolved,
      rawSourceRefs: r.sourceRefs,
    });
    autoIndex += 1;
    if (scenes.length >= MAX_SCENES) break;
  }

  return scenes.length > 0 ? scenes : undefined;
}

/** Verifies each scene's sourceRefs against the case's actual documents (docId must resolve)
 * and, if a quote is given, against that document's sampled excerpt text — same verify-before-
 * ship discipline as legal_decisions.py's audit_decision_records, just for scenes instead of
 * chat conclusions. An unverifiable ref is dropped; a scene left with none gets a note in
 * `unresolved` instead of shipping ungrounded. */
export function auditScenes(
  rawScenes: (Omit<Scene, "sourceRefs"> & { rawSourceRefs: unknown })[],
  readyDocIds: Set<string>,
  corpusByDocId: Map<string, string>,
): Scene[] {
  return rawScenes.map((raw) => {
    const { rawSourceRefs, ...rest } = raw;
    const sourceRefs: SceneSourceRef[] = [];
    if (Array.isArray(rawSourceRefs)) {
      for (const ref of rawSourceRefs) {
        if (!ref || typeof ref !== "object") continue;
        const r = ref as Record<string, unknown>;
        const docId = trimmedString(r.docId, 100);
        if (!docId || !readyDocIds.has(docId)) continue;
        const page = typeof r.page === "number" ? r.page : null;
        const quote = trimmedString(r.quote, MAX_QUOTE_CHARS) ?? null;
        const corpus = corpusByDocId.get(docId) ?? "";
        const verified = !quote || corpus.includes(quote);
        if (!verified) continue;
        sourceRefs.push({ docId, page, quote, verified: true });
        if (sourceRefs.length >= MAX_SOURCE_REFS) break;
      }
    }

    const unresolved = [...rest.unresolved];
    if (sourceRefs.length === 0 && !unresolved.some((u) => u.toLowerCase().includes("no verified source"))) {
      unresolved.push("No verified source for this scene — treat as unconfirmed.");
    }

    return { ...rest, sourceRefs, unresolved };
  });
}
