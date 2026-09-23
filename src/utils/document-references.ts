import { DecisionEvidence, DecisionRecordItem, DecisionRecordsPayload } from "./response-parser";

/**
 * Keeps internal file identifiers out of anything a user reads.
 *
 * Case documents are identified by UUIDs, and those UUIDs reach the AI (the manifest, the
 * grounding context, the document blocks). The AI then sometimes copies one into its own output:
 * as the `doc` label of a Decision Record's evidence, or inline in the answer. A UUID is not a
 * secret, but it is meaningless to the reader and it is a handle other endpoints act on, so it
 * must never be displayed. Everything here is pure (no DB, no I/O); ChatSvc supplies the
 * documents that are actually in scope for the consultation/case.
 */

export interface DocumentRef {
  id: string;
  name: string;
}

/** What is shown when a label looks like an internal id but is not one of the documents in scope. */
export const GENERIC_DOCUMENT_LABEL = "Document";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_EXACT_RE = new RegExp(`^${UUID_SOURCE}$`, "i");

export function isUuidLike(value: unknown): boolean {
  return typeof value === "string" && UUID_EXACT_RE.test(value.trim());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every known document id in `text` with that document's name, and strips the
 * "(id: <uuid>)" / "id: <uuid>" fragments the grounding context teaches the AI to echo.
 * Unknown UUID-shaped strings are left alone (they may be some other, legitimate identifier);
 * only ids of documents in scope, and explicit "id:" labels, are touched.
 */
export function redactDocumentIds(text: string, docs: DocumentRef[]): string {
  if (!text) return text;
  let out = text;

  for (const doc of docs) {
    if (!doc.id || !isUuidLike(doc.id)) continue;
    const name = doc.name?.trim() || GENERIC_DOCUMENT_LABEL;
    // "Name (id: <uuid>)" -> "Name": the id fragment goes, the name already there stays.
    const trailing = new RegExp(`\\s*\\(\\s*id:\\s*${escapeRegExp(doc.id)}\\s*(?:,[^)]*)?\\)`, "gi");
    out = out.replace(trailing, "");
    out = out.replace(new RegExp(escapeRegExp(doc.id), "gi"), name);
  }

  // Any remaining explicit "(id: <uuid>...)" fragment, for a document we do not have a name for.
  out = out.replace(new RegExp(`\\s*\\(\\s*id:\\s*${UUID_SOURCE}\\s*(?:,[^)]*)?\\)`, "gi"), "");
  return out;
}

/** Lower-case, single-spaced, straight quotes and hyphens: what a verbatim quote is compared on. */
export function normalizeQuoteText(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteAppearsIn(quote: string, text: string): boolean {
  const q = normalizeQuoteText(quote);
  if (q.length < 8) return false; // a few words match anything; never count as verified
  return normalizeQuoteText(text).includes(q);
}

export interface SanitizeOptions {
  /** Full text per document id, used to re-check a quote once its document is known. Optional. */
  texts?: Map<string, string>;
}

function sanitizeEvidence(items: DecisionEvidence[], byId: Map<string, DocumentRef>, opts: SanitizeOptions): DecisionEvidence[] {
  return items.map((item) => {
    let { doc, docId, verified } = item;

    if (isUuidLike(doc)) {
      // The AI wrote a file id as the label. Resolve it against the documents in scope only:
      // an id that is not one of them must not be looked up (or confirmed) anywhere else.
      const match = byId.get(doc.trim().toLowerCase());
      if (match) {
        docId = docId ?? match.id;
        doc = match.name?.trim() || GENERIC_DOCUMENT_LABEL;
      } else {
        doc = GENERIC_DOCUMENT_LABEL;
      }
    } else if (docId) {
      const match = byId.get(docId.toLowerCase());
      if (match && match.name?.trim() && !doc.trim()) doc = match.name.trim();
    }

    // Only ever upgrade: chat-wonder could not resolve the label, so `verified` was false even
    // though the document (and quote) may be real. Confirm it from the document's own text.
    if (!verified && docId && item.quote && opts.texts) {
      const text = opts.texts.get(docId.toLowerCase()) ?? opts.texts.get(docId);
      if (text && quoteAppearsIn(item.quote, text)) verified = true;
    }

    return { ...item, doc, docId: docId ?? null, verified };
  });
}

/** Ids in the AI's free-text fields (conclusion, weighting, ...) are redacted the same way. */
function redactRecordText(record: DecisionRecordItem, docs: DocumentRef[]): DecisionRecordItem {
  const r = (s: string) => redactDocumentIds(s, docs);
  return {
    ...record,
    conclusion: r(record.conclusion),
    weighting: r(record.weighting),
    wouldChangeIf: record.wouldChangeIf.map(r),
    alternatives: record.alternatives.map((a) => ({
      ...a,
      position: r(a.position),
      whyRejected: r(a.whyRejected),
    })),
  };
}

/** True when sanitizing could change something: lets callers skip the document lookup entirely. */
export function decisionRecordsNeedSanitizing(payload: unknown): boolean {
  const records = (payload as { records?: unknown })?.records;
  if (!Array.isArray(records)) return false;
  return records.some((rec: any) =>
    [...(rec?.evidenceFor ?? []), ...(rec?.evidenceAgainst ?? [])].some(
      (e: any) => isUuidLike(e?.doc) || (e?.quote && e?.verified !== true && e?.docId),
    ),
  );
}

export function sanitizeDecisionRecords(
  payload: DecisionRecordsPayload,
  docs: DocumentRef[],
  opts: SanitizeOptions = {},
): DecisionRecordsPayload {
  const byId = new Map(docs.map((d) => [d.id.toLowerCase(), d]));
  return {
    ...payload,
    records: payload.records.map((record) => {
      const cleaned = redactRecordText(record, docs);
      return {
        ...cleaned,
        evidenceFor: sanitizeEvidence(record.evidenceFor, byId, opts),
        evidenceAgainst: sanitizeEvidence(record.evidenceAgainst, byId, opts),
      };
    }),
  };
}
