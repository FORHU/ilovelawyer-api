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
import { fingerprintMindMapDocuments, mindMapDocumentIds } from "../utils/ready-set-fingerprint";
import { extractMindMap, MindMapItem } from "../utils/response-parser";
import { keepOnlyCaseSources, syncRemovedSources } from "../utils/mind-map-tree";
import { formatLawyerChanges, formatMindMapOutline, lawyerChangesSince } from "../utils/mind-map-lawyer-changes";
import { applyMindMapChecks, checkMindMapNodes, isMindMapJevEnabled, nodesToCheck } from "../utils/mind-map-jev";
import { CASE_MIND_MAP_AUTO } from "../config";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import logger from "../utils/logger";

// Re-exported for callers/tests that knew it here first.
export { keepOnlyCaseSources };

/** Key dates the prompt lists — enough to anchor Key Facts without crowding out the excerpts. */
const MAX_KEY_DATES = 40;

/** Cap on the case digest sent with a chat map request (buildChatContext) — it rides along with
 * the whole chat turn, so it stays a summary, not a second copy of the case. */
export const CHAT_MIND_MAP_CONTEXT_MAX_CHARS = 6000;
/** Cap on the current map's outline sent with it (the lawyer's changes marked), on top of the digest. */
export const CHAT_MIND_MAP_OUTLINE_MAX_CHARS = 5000;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", tl: "Filipino (Tagalog)", ko: "Korean" };

/** Delay before the retry after a document change found a map build running — about one build. */
export const CASE_MIND_MAP_RESYNC_DELAY_SECONDS = 60;
/** Life of the "retry already queued" flag: well past the retry's delay plus queue wait, and short
 * enough that a lost queue message only holds up later retries briefly. */
const RESYNC_FLAG_TTL_SECONDS = 10 * 60;
const resyncFlagKey = (caseId: string) => `case-mind-map:resync-queued:${caseId}`;

/** The 409 AiGenerationLockSvc.begin throws while another "caseMindMap" build holds the lock. */
export function isCaseMindMapBusy(err: unknown): boolean {
  return err instanceof HttpError && err.statusCode === 409;
}

/** "auto" = after documents change (post-upload refresh); "refresh" = the lawyer's "Refresh
 * analysis", which re-runs the findings/strategy the map is built from; "manual" = Regenerate on
 * the map itself. */
export type CaseMindMapBuildReason = "auto" | "refresh" | "manual";

/** Why a build didn't replace the map — logged, and returned so callers/tests can tell. */
export type CaseMindMapSkip =
  | "disabled"
  | "noDocuments"
  | "retired"
  | "unchanged"
  | "userChanges"
  | "unusableReply"
  | "changedWhileBuilding";

/**
 * The case's mind map, built straight from its uploaded documents — the map equivalent of the
 * timeline's key dates: CaseRefreshSvc runs it after case strategy/findings on every post-upload
 * refresh, and Studio shows it (see CaseMindMap's schema comment).
 *
 * Built from the case's documents that are indexed and not archived (mindMapDocumentIds).
 *
 * An automatic run never overwrites work: it skips when those documents haven't changed since the
 * last build ("Refresh analysis" rebuilds anyway, since the findings/strategy it reads were just
 * re-run), and when anyone has expanded or edited the map since then — the map then shows Stale,
 * citations to removed documents are dropped (syncRemovedSources), and the lawyer decides whether
 * to Regenerate. When the last document goes, the map is retired rather than left up. A manual
 * Regenerate ("manual") rebuilds regardless.
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

  /**
   * The case digest a chat turn that asks for a map sends along (`case_mind_map_context`), so
   * chat-wonder's map generator can build the tree from the case — its findings, key dates,
   * strategy and documents — instead of only the answer text it just wrote. Same inputs as a
   * document build's prompt, minus the excerpts (the turn already carries document grounding),
   * plus the case map as it stands now, with the lawyer's own edits marked.
   */
  static async buildChatContext(caseId: string): Promise<string> {
    const [header, findings, timeline, procedureItems, docs, current] = await Promise.all([
      CaseRepo.findPromptHeader(caseId),
      CaseFindingRepo.list(caseId),
      CaseTimelineRepo.list(caseId),
      ProceduralDeadlineRepo.listProcedureItems(caseId),
      DocumentRepo.listAllByCase(caseId),
      CaseMindMapSvc.currentMapWithLawyerChanges(caseId),
    ]);
    const section = (title: string, lines: string[]) => (lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : "");
    const text = [
      header ? `Case: ${[header.caseName, header.actionType, header.jurisdiction].filter(Boolean).join(" — ")}` : "",
      section("Findings", findings.map((f) => `${f.category}: ${f.label}`)),
      section(
        "Key dates",
        timeline.slice(0, MAX_KEY_DATES).map((t) => `${t.occurredOn ? t.occurredOn.toISOString().slice(0, 10) : "undated"} — ${t.title}`),
      ),
      section(
        "Strategy and to-dos",
        procedureItems.filter((p) => p.kind === "STRATEGY" || p.kind === "TODO").map((p) => `${p.kind}: ${p.label}`),
      ),
      section("Documents", docs.filter((d) => d.ragStatus === "READY").map((d) => d.name)),
    ]
      .filter(Boolean)
      .join("\n\n");
    const digest = text.length > CHAT_MIND_MAP_CONTEXT_MAX_CHARS ? `${text.slice(0, CHAT_MIND_MAP_CONTEXT_MAX_CHARS)}\n…` : text;
    // The map as it stands, with the lawyer's own changes marked, so a map asked for in chat
    // builds on it rather than starting over. Capped on its own (formatMindMapOutline).
    const outline = current ? formatMindMapOutline(current.tree, current.changes, CHAT_MIND_MAP_OUTLINE_MAX_CHARS) : "";
    return [digest, outline].filter(Boolean).join("\n\n");
  }

  /**
   * What every case chat turn tells chat-wonder about the lawyer's hand edits to the case map
   * (added, reworded and removed points; see formatLawyerChanges) — only the changes, not the
   * whole map, so an ordinary turn stays cheap. Empty when the case has no map or no such edits.
   */
  static async lawyerChangesContext(caseId: string): Promise<string> {
    const current = await CaseMindMapSvc.currentMapWithLawyerChanges(caseId);
    return current ? formatLawyerChanges(current.tree, current.changes) : "";
  }

  /** The case map on screen and the lawyer's edits since its build; null with no live map. */
  private static async currentMapWithLawyerChanges(caseId: string) {
    const map = await MindMapRepo.findCaseMap(caseId);
    if (!map || map.retiredAt) return null;
    const versions = await MindMapRepo.listCaseVersionsSinceBuild(map.id);
    return { tree: map.data as unknown as MindMapItem, changes: lawyerChangesSince(versions) };
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

  /**
   * A document change reached the map while another build held its lock (a Regenerate, or another
   * refresh's build) — that build may have read the documents before the change, so queue one
   * retry for after it instead of dropping the change.
   *
   * Coalesced: a Redis flag (SET NX) marks "a retry is queued", so any number of changes while the
   * build runs queue one retry, not one per document. runResync clears the flag before it builds,
   * so a change that lands during the retry's own build queues the next one. When Redis can't be
   * reached it queues anyway: a spare retry is a cheap no-op ("unchanged"), a lost one leaves the
   * map behind. Returns whether this call queued the retry.
   */
  static async scheduleResync(caseId: string, userId: string): Promise<boolean> {
    const claimed = await redis.setIfAbsent(resyncFlagKey(caseId), userId, RESYNC_FLAG_TTL_SECONDS);
    if (claimed === false) {
      logger.info("Case mind map: resync already queued, coalesced", { caseId });
      return false;
    }
    // Dynamic: ai-generation.queue.ts imports this service at the top level.
    const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
    AiGenerationQueue.enqueue({ kind: "caseMindMapResync", caseId, userId }, CASE_MIND_MAP_RESYNC_DELAY_SECONDS);
    logger.info("Case mind map: resync queued behind a running build", { caseId, delaySeconds: CASE_MIND_MAP_RESYNC_DELAY_SECONDS });
    return true;
  }

  /** The queued retry (see scheduleResync). An automatic build, so the usual rules hold: skipped
   * when the documents already match the map (the running build caught the change after all), and
   * never over a map someone has expanded or edited. Still busy → queues the next retry. */
  static async runResync(caseId: string, userId: string): Promise<void> {
    await redis.del(resyncFlagKey(caseId));
    if (!(await CaseRepo.exists(caseId))) return;
    try {
      const result = await CaseMindMapSvc.generateFromDocuments(caseId, userId, "auto");
      logger.info("Case mind map: resync done", { caseId, skipped: result.skipped });
    } catch (err) {
      if (isCaseMindMapBusy(err)) await CaseMindMapSvc.scheduleResync(caseId, userId);
      else logger.warn("Case mind map: resync failed", { err, caseId });
    }
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

  /** Fire-and-forget checkCaseMap — logs rather than throws, since nothing is waiting on it. */
  static checkInBackground(caseId: string, onlyIds?: Set<string>): void {
    if (!isMindMapJevEnabled()) return;
    CaseMindMapSvc.checkCaseMap(caseId, onlyIds).catch((err) => {
      logger.warn("Case mind map: Jev check failed", { err, caseId });
    });
  }

  /**
   * Has Jev check the case map's cited points (all of them after a build, `onlyIds` after an
   * expand) and saves the verdicts as a "check" version — which isn't a user change, so it never
   * blocks an automatic rebuild (see MindMapRepo.caseMapHasUserChanges). The checks run on the
   * map as it was read; the save re-reads the latest map and only attaches a verdict to a node
   * that still says what Jev saw (applyMindMapChecks), retrying if the map moved on meanwhile.
   * Returns how many verdicts landed. No-op unless USE_JEV_MINDMAP=true.
   */
  static async checkCaseMap(caseId: string, onlyIds?: Set<string>): Promise<number> {
    if (!isMindMapJevEnabled()) return 0;
    const map = await MindMapRepo.findCaseMap(caseId);
    if (!map) return 0;
    const nodes = nodesToCheck(map.data as unknown as MindMapItem, onlyIds);
    if (!nodes.length) return 0;

    const startedAt = Date.now();
    const docs = await DocumentRepo.listAllByCase(caseId);
    const results = await checkMindMapNodes(nodes, new Map(docs.map((d) => [d.id, d.name])));
    if (!results.length) return 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const latest = await MindMapRepo.findCaseMap(caseId);
      if (!latest) return 0;
      const { tree, applied } = applyMindMapChecks(latest.data as unknown as MindMapItem, results);
      if (!applied) return 0;
      try {
        await MindMapRepo.saveNewVersion({
          kind: "case",
          mindMapId: latest.id,
          expectedVersion: latest.version,
          previousData: latest.data as unknown as MindMapItem,
          data: tree,
          reason: "check",
        });
        const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.check.verdict]: (acc[r.check.verdict] ?? 0) + 1 }), {});
        logger.info("Case mind map: Jev checks saved", { caseId, checked: results.length, applied, ...counts, durationMs: Date.now() - startedAt });
        return applied;
      } catch (err) {
        if (!(err instanceof MindMapVersionConflictError) || attempt === 3) throw err;
      }
    }
    return 0;
  }

  /**
   * Whether the map is out of step with the case's documents — for the post-upload job when the
   * case's own READY set didn't change (so no full refresh runs) but the map's set did: a document
   * was archived or unarchived. False when there's no map yet; building a first map is the full
   * refresh's job.
   */
  static async documentsChangedSinceBuild(caseId: string): Promise<boolean> {
    const map = await MindMapRepo.findCaseMapMeta(caseId);
    if (!map) return false;
    const docs = await DocumentRepo.listAllByCase(caseId);
    if (map.retiredAt) return mindMapDocumentIds(docs).length > 0;
    return map.readySetFingerprint !== fingerprintMindMapDocuments(docs);
  }

  /** Step 31: drops citations to removed documents on a map the refresh isn't rebuilding, saved
   * as a "sync" version (not a user change). Returns how many points changed; 0 when none, or
   * when the map moved on meanwhile (the next refresh tries again). */
  private static async syncRemovedDocuments(map: { id: string; version: number; data: unknown }, current: Set<string>): Promise<number> {
    const result = syncRemovedSources(map.data as unknown as MindMapItem, current);
    if (!result) return 0;
    try {
      await MindMapRepo.saveNewVersion({
        kind: "case",
        mindMapId: map.id,
        expectedVersion: map.version,
        previousData: map.data as unknown as MindMapItem,
        data: result.tree,
        reason: "sync",
      });
      return result.changed;
    } catch (err) {
      if (err instanceof MindMapVersionConflictError) return 0;
      throw err;
    }
  }

  private static async build(caseId: string, userId: string | undefined, reason: CaseMindMapBuildReason) {
    const startedAt = Date.now();
    const skip = async (skipped: CaseMindMapSkip, extra: object = {}) => {
      logger.info("Case mind map: build skipped", { caseId, reason, skipped, ...extra });
      return { skipped, map: await MindMapRepo.findCaseMap(caseId) };
    };

    const docs = await DocumentRepo.listAllByCase(caseId);
    const currentIds = mindMapDocumentIds(docs);
    const current = new Set(currentIds);
    const ready = docs.filter((d) => current.has(d.id)).map((d) => ({ id: d.id, name: d.name }));
    const existing = await MindMapRepo.findCaseMap(caseId);

    if (!ready.length) {
      // Every document the map was built from is gone (deleted or archived): hide it rather than
      // keep showing points drawn from documents that are no longer in the case.
      if (existing && !existing.retiredAt) {
        await MindMapRepo.retireCaseMap(existing.id);
        return skip("retired");
      }
      return skip("noDocuments");
    }

    const fingerprint = fingerprintMindMapDocuments(docs);
    // A retired map's documents are all gone, so it's rebuilt fresh whatever happened to it
    // before; Regenerate ("manual") always rebuilds.
    if (existing && !existing.retiredAt && reason !== "manual") {
      if (reason === "auto" && existing.readySetFingerprint === fingerprint) return skip("unchanged");
      if (await MindMapRepo.caseMapHasUserChanges(existing.id)) {
        const syncedPoints = await CaseMindMapSvc.syncRemovedDocuments(existing, current);
        return skip("userChanges", { syncedPoints });
      }
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
    // post-answer extras this call never uses. skipLegalVerify: the reply is the map's JSON, not
    // an answer, so chat-wonder's quotation/contradiction self-check would only add a rewrite round.
    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    const call = (sessionId: string) =>
      streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, {
        resolveOnAnswerEnd: true,
        skipLegalVerify: true,
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
      MindMapRepo.saveCaseBuild({ caseId, expectedVersion, data: tree, readySetFingerprint: fingerprint, documentIds: currentIds, userId });
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
      // After the save, not before: the map is on screen now and the verdicts arrive as they're
      // ready — the build (and the refresh pipeline waiting on it) never waits on Jev.
      CaseMindMapSvc.checkInBackground(caseId);
      return { skipped: null, map: await MindMapRepo.findCaseMap(caseId) };
    } catch (err) {
      // Someone expanded the map while the model was running — their change wins; the map goes
      // Stale and the next build (or a Regenerate) picks the new documents up.
      if (err instanceof MindMapVersionConflictError) return skip("changedWhileBuilding");
      throw err;
    }
  }
}

function countNodes(node: MindMapItem): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}
