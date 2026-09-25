import prisma from "../lib/prisma";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import logger from "../utils/logger";
import { scanAnswer, buildBundleView, BundleView, CitationRef } from "../utils/answer-grounding";
import { checkAssertionWithJev } from "../utils/assertion-check";
import AnswerGroundingRepo from "../repositories/answer-grounding.repository";
import CaseAccess from "../utils/case-access";

/**
 * Phase 1 of docs/plans/grounding-verifier.md: after an answer is persisted, check what it claimed
 * against what the bundle actually holds, and record the result.
 *
 * Runs AFTER ChatSvc.persistAssistantTurn, never before. The lawyer already has their reply; this
 * attaches to it. Nothing here may throw into the worker, delay chat:done, or alter the answer —
 * Phase 2 is where verdicts feed back into generation, and only once the detection numbers in
 * benchmarks/jev-grounding earn it.
 */

/** Unset/false: no scan at all, not even the free half. Read per call, not captured at module
 * load — see the same note on message-triage.ts: a captured flag makes the value depend on import
 * order relative to dotenv.config(). */
function verifierEnabled(): boolean {
  return process.env.USE_GROUNDING_VERIFIER === "true";
}

/** Assertions checked per answer, most-cited first. A Brackenmoor-sized answer carries 85–276
 * citations; verifying every one would cost more than the turn did. */
const MAX_ASSERTIONS = Number(process.env.GROUNDING_MAX_ASSERTIONS || 40);

/** Jev calls in flight at once. Serial would be ~30s for a long answer; this keeps it near 3s
 * without opening the floodgates on a shared key. */
const CONCURRENCY = 10;

/** Characters of the cited document handed to Jev as the passage. */
const PASSAGE_BUDGET = 3500;

export interface GroundingCounts {
  FALSE_ABSENCE: number;
  NOT_SUPPLIED: number;
  CORRECT_ABSENCE: number;
  UNRESOLVED: number;
  SUPPORTED: number;
  UNSUPPORTED: number;
  CONTRADICTED: number;
  checked: number;
}

function emptyCounts(): GroundingCounts {
  return { FALSE_ABSENCE: 0, NOT_SUPPLIED: 0, CORRECT_ABSENCE: 0, UNRESOLVED: 0, SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0, checked: 0 };
}

/**
 * A window of the cited document around the locator, or the head of it when the locator cannot be
 * found. Exact passage resolution is an open question in the plan — a merged bundle upload has no
 * exhibit boundaries to resolve against at all — so `located` is returned alongside and stored,
 * because a verdict reached on a fallback window is weaker evidence than one reached on a hit.
 */
export function extractPassage(text: string, locator: string | undefined, budget = PASSAGE_BUDGET): { passage: string; located: boolean } {
  if (!text) return { passage: "", located: false };
  const num = locator?.match(/\d+(?:\.\d+)*/)?.[0];
  if (locator && num) {
    const escaped = num.replace(/\./g, "\\.");
    const word = /part/i.test(locator) ? "Part" : /appendix/i.test(locator) ? "Appendix" : /item/i.test(locator) ? "item" : "para";
    for (const re of [new RegExp(`\\b${word}\\s*${escaped}\\b`, "i"), new RegExp(`(^|\\n)\\s*${escaped}[.)\\s]`, "m")]) {
      const m = re.exec(text);
      if (m) {
        const start = Math.max(0, m.index - 200);
        return { passage: text.slice(start, start + budget), located: true };
      }
    }
  }
  return { passage: text.slice(0, budget), located: false };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

export interface VerifyInput {
  assistantMessageId: string;
  caseId: string;
  answer: string;
  /** Case documents whose ranked chunks were inlined into document_context this turn. */
  rankedDocumentIds: string[];
  /** Case documents whose FULL text was inlined (ChatWonderStreamResult.inlinedCaseDocumentIds). */
  inlinedDocumentIds: string[];
}

/**
 * Scans one answer and writes AnswerGroundingCheck rows. Returns the counts so the caller can push
 * them over the socket. Never throws: every failure path logs and returns what it has, because a
 * verification pass that can take a chat turn down with it is worse than no verification at all.
 */
export default class GroundingVerifierSvc {
  static get enabled(): boolean {
    return verifierEnabled();
  }

  /** Verification panel feed. Goes through CaseAccess like every other case-scoped read, so a
   * verification row can never become a way to see a case you have no access to. */
  static async listForCase(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const [rows, counts] = await Promise.all([AnswerGroundingRepo.listForCase(caseId), AnswerGroundingRepo.countsForCase(caseId)]);
    return { counts, rows };
  }

  /** One row with the passage it was judged against — the audit view for a disputed verdict. */
  static async getCheck(caseId: string, id: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return AnswerGroundingRepo.findById(id, caseId);
  }

  static async verifyAnswer(input: VerifyInput): Promise<GroundingCounts> {
    const counts = emptyCounts();
    if (!verifierEnabled() || !input.answer?.trim() || !input.caseId) return counts;

    try {
      const documents = await prisma.document.findMany({
        where: { caseId: input.caseId, ragStatus: "READY" },
        select: { id: true, name: true },
      });
      if (!documents.length) return counts;

      // "Supplied" means the model actually received the text — full inline, or the ranked chunks
      // that went into document_context. A document merely attached to the case does not count:
      // that distinction is the whole reason FALSE_ABSENCE and NOT_SUPPLIED are separate verdicts.
      const supplied = new Set([...input.inlinedDocumentIds, ...input.rankedDocumentIds]);
      const view: BundleView = buildBundleView(documents, supplied);
      const scan = scanAnswer(input.answer, view);

      const rows: {
        messageId: string;
        caseId: string;
        kind: string;
        assertion: string;
        citation?: string;
        documentId?: string;
        passage?: string;
        verdict: string;
        confidence?: number;
        evidenceKind?: string;
      }[] = [];

      for (const claim of scan.absenceClaims) {
        counts[claim.verdict]++;
        counts.checked++;
        rows.push({
          messageId: input.assistantMessageId,
          caseId: input.caseId,
          kind: "ABSENCE_CLAIM",
          assertion: claim.sentence,
          citation: claim.citations[0]?.raw,
          documentId: claim.documentId,
          verdict: claim.verdict,
        });
      }

      // Only assertions whose document we actually hold text for can be judged; the rest would be
      // a Jev call against an empty passage, which is a guaranteed UNSUPPORTED and tells us
      // nothing. They are recorded as UNRESOLVED instead, and that count is itself a signal.
      const texts = await DocumentChunkRepo.findFullTextsByDocuments(documents.map((d) => d.id));
      const candidates = scan.assertions
        .map((a) => {
          const ref: CitationRef | undefined = a.citations[0];
          const documentId = ref ? view.inCase[ref.document] : undefined;
          return { ...a, ref, documentId, text: documentId ? texts.get(documentId) ?? "" : "" };
        })
        .slice(0, MAX_ASSERTIONS);

      const checkable = candidates.filter((c) => c.text);
      for (const c of candidates.filter((c) => !c.text)) {
        counts.UNRESOLVED++;
        counts.checked++;
        rows.push({
          messageId: input.assistantMessageId,
          caseId: input.caseId,
          kind: "ASSERTION",
          assertion: c.assertion,
          citation: c.ref?.raw,
          verdict: "UNRESOLVED",
        });
      }

      const judged = await mapWithConcurrency(checkable, CONCURRENCY, async (c) => {
        const { passage } = extractPassage(c.text, c.ref?.locator);
        try {
          const result = await checkAssertionWithJev(c.assertion, passage, c.ref?.raw);
          return { c, passage, result };
        } catch (err) {
          logger.warn("Grounding verifier: Jev error on one assertion", { err, citation: c.ref?.raw });
          return { c, passage, result: null };
        }
      });

      for (const { c, passage, result } of judged) {
        counts.checked++;
        if (!result) {
          counts.UNRESOLVED++;
          rows.push({
            messageId: input.assistantMessageId,
            caseId: input.caseId,
            kind: "ASSERTION",
            assertion: c.assertion,
            citation: c.ref?.raw,
            documentId: c.documentId,
            verdict: "UNRESOLVED",
          });
          continue;
        }
        counts[result.verdict]++;
        rows.push({
          messageId: input.assistantMessageId,
          caseId: input.caseId,
          kind: "ASSERTION",
          assertion: c.assertion,
          citation: c.ref?.raw,
          documentId: c.documentId,
          passage,
          verdict: result.verdict,
          confidence: result.confidence,
          evidenceKind: result.evidenceKind,
        });
      }

      if (rows.length) await prisma.answerGroundingCheck.createMany({ data: rows });

      logger.info("Grounding verifier: answer checked", {
        assistantMessageId: input.assistantMessageId,
        caseId: input.caseId,
        ...counts,
        citationsSeen: scan.counts.citations,
        assertionsSeen: scan.counts.assertions,
      });
      return counts;
    } catch (err) {
      logger.error("Grounding verifier: scan failed — the answer is unaffected", {
        err,
        assistantMessageId: input.assistantMessageId,
        caseId: input.caseId,
      });
      return counts;
    }
  }
}
