import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
import CaseAccess from "../utils/case-access";
import EvidenceRepo from "../repositories/evidence.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import WitnessRepo from "../repositories/witness.repository";
import { extractFacts, findContradictions, ContradictionHit } from "../utils/fact-extract";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { buildContradictionPrompt } from "../constants";
import { extractContradictionHits, uniqueContradictionHits } from "../utils/contradiction-scan";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import logger from "../utils/logger";
import { PrivilegeStatus, HearsayCategory, ContradictionStatus } from "@prisma/client";
import { contradictionKey } from "../utils/contradiction-key";
import { diffContradictions } from "../utils/case-change-delta";
import CaseChangeRun from "./case-change-run.service";
import { classifyContradictionWithJev, isContradictionJevEnabled } from "../utils/contradiction-nature-jev";
import FullContradictionScanSvc, { FullScanHit, isFullContradictionScanEnabled } from "./full-contradiction-scan.service";
import { TenantCode } from "../types/tenant-code";
import AiGenerationLockSvc from "./ai-generation-lock.service";

/** A triage status as the change log names it. */
const TRIAGE_ACTION = { RESOLVED: "resolved", DISMISSED: "dismissed", OPEN: "reopened" } as const;

export default class EvidenceIntelligenceSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const [matrix, contradictions] = await Promise.all([
      EvidenceRepo.listMatrix(caseId),
      EvidenceRepo.listContradictions(caseId),
    ]);
    return { matrix, contradictions };
  }

  static async upsertMatrix(
    caseId: string,
    userId: string,
    documentId: string,
    data: {
      authenticity?: string;
      admissibility?: string;
      probative?: string;
      originalFile?: boolean;
      needsVerify?: boolean;
      notes?: string | null;
      privilegeStatus?: PrivilegeStatus;
      hearsayCategory?: HearsayCategory;
      sponsoringWitnessId?: string | null;
    },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    if (!docs.some((d) => d.id === documentId)) throw new HttpError("Document not found on this case", 404);
    if (data.sponsoringWitnessId) {
      const witnesses = await WitnessRepo.list(caseId);
      if (!witnesses.some((w) => w.id === data.sponsoringWitnessId)) {
        throw new HttpError("Witness not found on this case", 404);
      }
    }
    const before = await EvidenceRepo.findMatrixItem(caseId, documentId);
    const row = await EvidenceRepo.upsertMatrix(caseId, documentId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "evidence.matrix.upsert", payload: { documentId } });
    await ManualEditLog.record(caseId, userId, {
      pane: "evidence",
      kind: "evidenceRating",
      itemId: documentId,
      action: "edited",
      label: docs.find((d) => d.id === documentId)?.name ?? "Document",
      changes: fieldChanges(before, data, {
        authenticity: "value",
        admissibility: "value",
        probative: "value",
        originalFile: "value",
        needsVerify: "value",
        notes: "text",
        privilegeStatus: "value",
        hearsayCategory: "value",
        sponsoringWitnessId: "text",
      }),
    });
    return row;
  }

  static async addCustodyEvent(
    caseId: string,
    userId: string,
    documentId: string,
    data: { custodianName: string; action: string; occurredAt: Date; notes?: string | null },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    if (!docs.some((d) => d.id === documentId)) throw new HttpError("Document not found on this case", 404);
    const matrixItem = await EvidenceRepo.upsertMatrix(caseId, documentId, {});
    const event = await EvidenceRepo.addCustodyEvent(matrixItem.id, data);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "evidence.custody.add",
      payload: { documentId, custodianName: data.custodianName },
    });
    const docName = docs.find((d) => d.id === documentId)?.name ?? "Document";
    await ManualEditLog.record(caseId, userId, {
      pane: "evidence",
      kind: "custodyEvent",
      itemId: event.id,
      action: "added",
      label: `${docName}: ${data.action} (${data.custodianName})`,
    });
    return event;
  }

  static async deleteCustodyEvent(caseId: string, userId: string, documentId: string, eventId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    if (!docs.some((d) => d.id === documentId)) throw new HttpError("Document not found on this case", 404);
    const matrixItem = await EvidenceRepo.findMatrixItem(caseId, documentId);
    if (!matrixItem) throw new HttpError("Evidence item not found for this document", 404);
    const event = await EvidenceRepo.findCustodyEvent(matrixItem.id, eventId);
    const deleted = await EvidenceRepo.deleteCustodyEvent(matrixItem.id, eventId);
    if (!deleted) throw new HttpError("Custody event not found", 404);
    const docName = docs.find((d) => d.id === documentId)?.name ?? "Document";
    await ManualEditLog.record(caseId, userId, {
      pane: "evidence",
      kind: "custodyEvent",
      itemId: eventId,
      action: "removed",
      label: event ? `${docName}: ${event.action} (${event.custodianName})` : docName,
    });
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "evidence.custody.delete",
      payload: { documentId, eventId },
    });
  }

  /** Wrapped at this shared level (not the controller) so both the Contradictions panel's own
   * "Scan" button and the global case-refresh action — which both call this method — protect
   * each other: whichever calls first wins the lock, the other gets a clean 409 instead of the
   * two racing. */
  static async scanContradictions(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "contradictions", () => EvidenceIntelligenceSvc.scanContradictionsInner(caseId));
  }

  /** Fast half of the panel's queued "Scan" — access check + claiming the job row, so a 403/409
   * comes back immediately. A full-bundle scan can take minutes, far past an HTTP request. */
  static async beginQueuedScan(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "contradictions");
  }

  /** Run by AiGenerationQueue's worker after beginQueuedScan has claimed the job row. */
  static async runQueuedScan(caseId: string, userId?: string): Promise<void> {
    // The panel's own Scan: the "What changed" modal then describes this run (CaseChangeRun).
    await AiGenerationLockSvc.finishWith(caseId, "contradictions", () =>
      CaseChangeRun.regenerate(
        caseId,
        userId ?? null,
        "contradictions",
        // The scan compares against the table it replaces itself; nothing to read around it.
        async () => null,
        () => EvidenceIntelligenceSvc.scanContradictionsInner(caseId),
        (_before, _after, { delta }) => delta,
      ),
    );
  }

  private static async scanContradictionsInner(caseId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY");

    const regexHits = uniqueContradictionHits(await scanWithRegex(ready));
    let hits = regexHits;

    try {
      const llmHits = await scanWithChatWonder(ready, tenantCode, caseId);
      // undefined = missing/unparseable block → keep regex. [] = model found none → show none.
      if (llmHits) hits = uniqueContradictionHits(llmHits);
    } catch (err) {
      logger.warn("Chat Wonder contradiction scan failed; using regex fallback", { err, caseId });
    }

    // Full-bundle scan: every chunk, Jev-checked pairs, exhibit/page locators. Added to the sample
    // scan's hits, not replacing them — it only sees dates/amounts/durations, the sample scan also
    // catches names and wording. A sample hit the full scan also found (same documents, same two
    // values) is dropped in favour of the full scan's, which says where in the bundle each side is.
    let fullHits: FullScanHit[] = [];
    if (isFullContradictionScanEnabled()) {
      try {
        fullHits = (await FullContradictionScanSvc.scan(caseId, ready, tenantCode)).hits;
      } catch (err) {
        logger.warn("Full contradiction scan failed; keeping the sample scan's results only", { err, caseId });
      }
    }
    let allHits: (ContradictionHit | FullScanHit)[] = hits;
    if (fullHits.length) {
      const sameConflict = (h: ContradictionHit) =>
        [`${h.leftDocumentId}=${h.leftValue}`, `${h.rightDocumentId}=${h.rightValue}`].sort().join("|");
      const covered = new Set(fullHits.map(sameConflict));
      allHits = [...hits.filter((h) => !covered.has(sameConflict(h))), ...fullHits];
    }

    // Every scan rebuilds the table, so carry the lawyer's triage and Jev's classification over
    // to each re-found contradiction; only ones not seen before, and not already classified by
    // the full scan, get sent to Jev.
    const previousRows = await EvidenceRepo.listContradictions(caseId);
    const previous = new Map(previousRows.map((row) => [contradictionKey(row), row]));
    const docName = new Map(ready.map((d) => [d.id, d.name]));
    const jev = isContradictionJevEnabled();
    const fresh = allHits.filter((hit) => !previous.has(contradictionKey(hit)) && !("nature" in hit));
    const natures = jev ? await classifyNatures(fresh, docName) : new Map<ContradictionHit, NatureRow>();

    const rows = allHits.map((hit) => {
      const own = "nature" in hit ? { nature: hit.nature, natureConfidence: hit.natureConfidence } : null;
      const prev = previous.get(contradictionKey(hit));
      if (prev) {
        return {
          ...hit,
          status: prev.status,
          resolutionNote: prev.resolutionNote,
          resolvedAt: prev.resolvedAt,
          resolvedById: prev.resolvedById,
          nature: prev.nature ?? own?.nature ?? natures.get(hit)?.nature ?? null,
          natureConfidence: prev.natureConfidence ?? own?.natureConfidence ?? natures.get(hit)?.natureConfidence ?? null,
        };
      }
      return { ...hit, ...(natures.get(hit) ?? {}) };
    });
    // What this scan changed against the table it replaces — the analysis refresh's change summary
    // (CaseRefreshSvc) reads it; the panel's own Scan ignores it.
    const delta = diffContradictions(previousRows, allHits, docName);
    logger.info("Contradiction scan: carried over", {
      caseId,
      total: allHits.length,
      fullScan: fullHits.length,
      carriedOver: delta.carriedOver,
      added: delta.addedCount,
      dropped: delta.droppedCount,
      jevClassified: natures.size,
    });
    return { rows: await EvidenceRepo.replaceContradictions(caseId, rows), delta };
  }

  static async updateContradiction(
    caseId: string,
    id: string,
    userId: string,
    data: { status: ContradictionStatus; resolutionNote?: string | null },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await EvidenceRepo.findContradiction(id, caseId);
    const row = await EvidenceRepo.updateContradictionStatus(id, caseId, {
      status: data.status,
      resolutionNote: data.resolutionNote?.trim() || null,
      resolvedById: userId,
    });
    if (!row) throw new HttpError("Contradiction not found", 404);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "evidence.contradiction.status",
      payload: { id, status: data.status },
    });
    if (before?.status !== row.status) {
      await ManualEditLog.record(caseId, userId, {
        pane: "evidence",
        kind: "contradiction",
        itemId: id,
        action: TRIAGE_ACTION[row.status],
        label: `${row.factKey}: ${row.leftValue} vs ${row.rightValue}`,
        changes: row.resolutionNote ? [{ field: "resolutionNote" }] : undefined,
      });
    }
    return row;
  }

  static async traces(caseId: string, userId: string, documentId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const doc = docs.find((d) => d.id === documentId);
    if (!doc) throw new HttpError("Document not found on this case", 404);
    const ids = await DocumentChunkRepo.findIdsByDocument(documentId);
    const chunks = await DocumentChunkRepo.findTextsByIds(ids);
    return {
      documentId,
      name: doc.name,
      pageCount: doc.pageCount,
      extractionMethod: doc.extractionMethod,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        pageNumber: chunk.pageNumber,
      })),
    };
  }
}

type ReadyDoc = { id: string; name: string };

type NatureRow = { nature: "DIRECT" | "INFERENTIAL" | "NOT_A_CONFLICT"; natureConfidence: number };

// Jev calls in flight at once while classifying a scan's new contradictions.
const JEV_CONCURRENCY = 5;

/** Jev's DIRECT/INFERENTIAL/NOT_A_CONFLICT read for each hit. A failed call leaves that hit out of
 * the map (nature stays null) — never a guessed classification. */
async function classifyNatures(hits: ContradictionHit[], docName: Map<string, string>): Promise<Map<ContradictionHit, NatureRow>> {
  const out = new Map<ContradictionHit, NatureRow>();
  for (let i = 0; i < hits.length; i += JEV_CONCURRENCY) {
    await Promise.all(
      hits.slice(i, i + JEV_CONCURRENCY).map(async (hit) => {
        try {
          const r = await classifyContradictionWithJev({
            factKey: hit.factKey,
            left: { document: docName.get(hit.leftDocumentId) ?? "Document A", excerpt: hit.leftExcerpt, value: hit.leftValue },
            right: { document: docName.get(hit.rightDocumentId) ?? "Document B", excerpt: hit.rightExcerpt, value: hit.rightValue },
          });
          out.set(hit, { nature: r.nature, natureConfidence: r.confidence });
        } catch (err) {
          logger.warn("Contradiction scan: Jev classification failed for one hit", { err, factKey: hit.factKey });
        }
      }),
    );
  }
  return out;
}

async function scanWithRegex(ready: ReadyDoc[]): Promise<ContradictionHit[]> {
  const perDoc: { documentId: string; facts: ReturnType<typeof extractFacts> }[] = [];
  for (const doc of ready) {
    const chunks = await DocumentChunkRepo.findTextsByIds(await DocumentChunkRepo.findIdsByDocument(doc.id));
    const text = chunks.map((c) => c.chunkText).join("\n");
    perDoc.push({ documentId: doc.id, facts: extractFacts(text) });
  }

  const hits: ContradictionHit[] = [];
  for (let i = 0; i < perDoc.length; i++) {
    for (let j = i + 1; j < perDoc.length; j++) {
      hits.push(...findContradictions(perDoc[i], perDoc[j]));
    }
  }
  return hits;
}

async function scanWithChatWonder(ready: ReadyDoc[], tenantCode: TenantCode, caseId: string): Promise<ContradictionHit[] | undefined> {
  if (ready.length < 1) return undefined;

  const caseDocumentIds = ready.map((doc) => doc.id);
  const pack = await buildFactExcerptPack(ready);
  const prompt = `${buildContradictionPrompt(ready)}

${wrapExtractedText(
    "Excerpts below were taken from the indexed files, including later pages of a bundled PDF. Compare facts across these excerpts. Quote from them.",
    pack.text,
  )}
`;

  const grounding = {
    caseDocumentIds,
    caseDocumentChunkIds: pack.chunkIds,
  };
  // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
  const trace = newTraceRun("contradictionScan", caseId);
  let sessionId = await getChatWonderSessionId();
  let payload: { response?: string; intermediate_response?: string };

  try {
    payload = await callChatWonderRest(prompt, sessionId, grounding, tenantCode, { trace });
  } catch {
    sessionId = await getChatWonderSessionId();
    payload = await callChatWonderRest(prompt, sessionId, grounding, tenantCode, { trace });
  }

  const text = String(payload.response || payload.intermediate_response || "");
  const parsed = extractContradictionHits(text, new Set(caseDocumentIds));
  logger.info("Chat Wonder contradiction scan reply", {
    readyCount: ready.length,
    chunkCount: pack.chunkIds.length,
    factChunkCount: pack.factCount,
    replyChars: text.length,
    parsedCount: parsed === undefined ? null : parsed.length,
  });
  return parsed;
}

