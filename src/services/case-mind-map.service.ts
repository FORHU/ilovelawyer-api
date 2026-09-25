import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import MindMapRepo, { MindMapVersionConflictError } from "../repositories/mind-map.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getMindMapDocumentsPromptBuilder } from "../legal/prompt-registry";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import { extractMindMap, MindMapItem } from "../utils/response-parser";
import { CASE_MIND_MAP_AUTO } from "../config";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";

/** Key dates the prompt lists — enough to anchor Key Facts without crowding out the excerpts. */
const MAX_KEY_DATES = 40;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", tl: "Filipino (Tagalog)", ko: "Korean" };

export type CaseMindMapBuildReason = "auto" | "manual";

/** Why a build didn't replace the map — logged, and returned so callers/tests can tell. */
export type CaseMindMapSkip = "disabled" | "noDocuments" | "unchanged" | "userChanges" | "unusableReply" | "changedWhileBuilding";

/**
 * The case's mind map, built straight from its uploaded documents — the map equivalent of the
 * timeline's key dates: CaseRefreshSvc runs it after case strategy/findings on every post-upload
 * refresh, and Studio shows it (see CaseMindMap's schema comment).
 *
 * An automatic run never overwrites work: it skips when the READY document set hasn't changed
 * since the last build, and when anyone has expanded or edited the map since then (the map then
 * shows Stale and the lawyer decides whether to Regenerate). A manual Regenerate ("manual")
 * rebuilds regardless.
 */
export default class CaseMindMapSvc {
  /** The case map for Studio, plus how many expands/edits a Regenerate would replace. Null
   * until the case's first build. */
  static async get(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const map = await MindMapRepo.findCaseMap(caseId);
    if (!map) return null;
    const { readySetFingerprint: _fingerprint, ...rest } = map;
    return { ...rest, expandedCount: await MindMapRepo.countCaseMapChangesSinceBuild(map.id) };
  }

  /** The post-upload refresh's step (CaseRefreshSvc.refreshInner). Holds its own "caseMindMap"
   * lock — separate from chat's "mindMap", so a background build never blocks a lawyer asking
   * for a map in chat, and vice versa. */
  static async generateFromDocuments(caseId: string, userId?: string, reason: CaseMindMapBuildReason = "auto") {
    if (reason === "auto" && !CASE_MIND_MAP_AUTO) {
      logger.info("Case mind map: automatic build disabled (CASE_MIND_MAP_AUTO=false)", { caseId });
      return { skipped: "disabled" as CaseMindMapSkip, map: await MindMapRepo.findCaseMap(caseId) };
    }
    return AiGenerationLockSvc.run(caseId, "caseMindMap", () => CaseMindMapSvc.build(caseId, userId, reason));
  }

  /** Fast, synchronous half of a Studio "Regenerate" on the case map — same beginQueued/
   * runQueued split as CaseTimelineSvc.beginQueuedGenerate. Anyone who can open the case, the
   * same rule as regenerating a chat map. */
  static async beginQueuedGenerate(caseId: string, userId: string): Promise<void> {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "caseMindMap");
  }

  /** Run by AiGenerationQueue's worker after beginQueuedGenerate claimed the job row. */
  static async runQueuedGenerate(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseMindMap", async () => {
      await CaseMindMapSvc.build(caseId, userId, "manual");
    });
  }

  private static async build(caseId: string, userId: string | undefined, reason: CaseMindMapBuildReason) {
    const startedAt = Date.now();
    const skip = async (skipped: CaseMindMapSkip, extra: object = {}) => {
      logger.info("Case mind map: build skipped", { caseId, reason, skipped, ...extra });
      return { skipped, map: await MindMapRepo.findCaseMap(caseId) };
    };

    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (!ready.length) return skip("noDocuments");

    const existing = await MindMapRepo.findCaseMap(caseId);
    const fingerprint = await computeReadySetFingerprint(caseId);
    if (existing && reason === "auto") {
      if (existing.readySetFingerprint === fingerprint) return skip("unchanged");
      if (await MindMapRepo.caseMapHasUserChanges(existing.id)) return skip("userChanges");
    }

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const [caseRecord, ukJurisdiction, findings, timeline, procedureItems] = await Promise.all([
      CaseRepo.findLanguage(caseId),
      tenantCode === "UK" ? CaseAccess.resolveUkJurisdiction(caseId) : Promise.resolve(null),
      CaseFindingRepo.list(caseId),
      CaseTimelineRepo.list(caseId),
      ProceduralDeadlineRepo.listProcedureItems(caseId),
    ]);
    const language = caseRecord?.language ?? "en";

    const pack = await buildFactExcerptPack(ready);
    const prompt = `${getMindMapDocumentsPromptBuilder(tenantCode)({
      docs: ready,
      findings: findings.map((f) => ({ category: f.category, label: f.label })),
      keyDates: timeline.slice(0, MAX_KEY_DATES).map((t) => ({ title: t.title, occurredOn: t.occurredOn })),
      strategy: procedureItems
        .filter((p) => p.kind === "STRATEGY" || p.kind === "TODO")
        .map((p) => ({ kind: p.kind, label: p.label })),
      language: LANGUAGE_NAMES[language] ?? language,
      ukJurisdiction,
    })}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents. Each excerpt starts with [documentId p.page].

${pack.text || "(no indexed text)"}
`;

    // One-shot over the WS path (not callChatWonderRest): a full map is a long reply, and the
    // REST call can hit the edge proxy's timeout — see RedTeamSvc. resolveOnAnswerEnd skips the
    // post-answer extras this call never uses.
    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    const call = (sessionId: string) =>
      streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, {
        resolveOnAnswerEnd: true,
      });
    let result;
    try {
      result = await call(await getChatWonderSessionId());
    } catch {
      result = await call(await getChatWonderSessionId());
    }

    // extractMindMap → normalizeMindMap: path ids, depth, MIND_MAP_LIMITS trimming.
    const tree = extractMindMap(result.content);
    const branchCount = tree?.children.length ?? 0;
    if (!tree || branchCount === 0) {
      return skip("unusableReply", { replyChars: result.content.length });
    }
    const dropped = keepOnlyCaseSources(tree, new Set(ready.map((d) => d.id)));

    const save = (expectedVersion: number | null) =>
      MindMapRepo.saveCaseBuild({ caseId, expectedVersion, data: tree, readySetFingerprint: fingerprint, documentCount: ready.length, userId });
    try {
      let saved;
      try {
        saved = await save(existing?.version ?? null);
      } catch (err) {
        // An explicit Regenerate is meant to replace the map, so an expand that landed while the
        // model was running doesn't stop it — save over the newer version once. An automatic
        // build yields instead (see the outer catch).
        if (!(err instanceof MindMapVersionConflictError) || reason !== "manual") throw err;
        saved = await save((await MindMapRepo.findCaseMap(caseId))?.version ?? null);
      }
      logger.info("Case mind map: built", {
        caseId,
        reason,
        version: saved.version,
        documents: ready.length,
        chunks: pack.chunkIds.length,
        nodes: countNodes(tree),
        droppedSources: dropped,
        durationMs: Date.now() - startedAt,
      });
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "mindMap.build",
        payload: { reason, version: saved.version, documents: ready.length },
      });
      return { skipped: null, map: await MindMapRepo.findCaseMap(caseId) };
    } catch (err) {
      // Someone expanded the map while the model was running — their change wins; the map goes
      // Stale and the next build (or a Regenerate) picks the new documents up.
      if (err instanceof MindMapVersionConflictError) return skip("changedWhileBuilding");
      throw err;
    }
  }
}

/** Drops `sources` entries whose documentId isn't one of the case's READY documents (the model
 * can mistype or invent ids). Mutates `tree`; returns how many were dropped. */
export function keepOnlyCaseSources(tree: MindMapItem, allowed: Set<string>): number {
  let dropped = 0;
  const walk = (node: MindMapItem) => {
    if (node.sources) {
      const kept = node.sources.filter((s) => allowed.has(s.documentId));
      dropped += node.sources.length - kept.length;
      if (kept.length) node.sources = kept;
      else delete node.sources;
    }
    node.children.forEach(walk);
  };
  walk(tree);
  return dropped;
}

function countNodes(node: MindMapItem): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}
