import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
import CaseChangeRun from "./case-change-run.service";
import { diffReconstruction } from "../utils/case-change-delta";
import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import CaseReconstructionEventsRepo from "../repositories/case-reconstruction-events.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { getCaseReconstructionPromptBuilder } from "../legal/prompt-registry";
import { extractRegisterNarratives, extractReconstructionGaps } from "../utils/case-reconstruction-parse";
import { extractReconstructionClaims } from "../utils/case-reconstruction-claims-parse";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import { parseRawScenes, auditScenes, Scene } from "../utils/case-reconstruction-scenes-parse";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";
import { cleanRegister } from "../utils/case-reconstruction.utils";
import { extractBundleFacts, BundleFact } from "../utils/bundle-facts";
import { buildDateAnchorPack, buildCaseReconstructionEventsPrompt } from "../utils/case-reconstruction-events-prompt";
import { parseRawEvents, auditEventsDetailed, summariseDrops } from "../utils/case-reconstruction-events-parse";
import { assessEvents, markUnchecked, isJevReconstructionEnabled } from "../utils/reconstruction-event-assess";
import { checkAssertionWithJev } from "../utils/assertion-check";
import { classifyEventPhrasingWithJev } from "../utils/event-phrasing-jev";
import { findEventBlockers, blockersMessage } from "../utils/reconstruction-prerequisites";

export default class CaseReconstructionSvc {
  static async get(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseReconstructionRepo.get(caseId);
  }

  /** Unqueued generate, holding the "caseReconstruction" lock. Used by autoRegenerate (the
   * analysis refresh's step) and case-post-extraction.ts's first-narrative fallback. userId is
   * optional for the same reason as CaseStrategySvc.generateFromDocuments. */
  static async generate(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstruction", () => CaseReconstructionSvc.generateInner(caseId, userId));
  }

  /** The analysis refresh's reconstruction step (CaseRefreshSvc). Generates the first narrative,
   * and regenerates it on later corpus changes while it is still the AI's — once a lawyer has
   * edited any register (narrativeEditedAt), it is left alone; the lawyer's Regenerate button
   * hands it back. */
  static async autoRegenerate(caseId: string, userId: string): Promise<"generated" | "regenerated" | "skipped-edited"> {
    const existing = await CaseReconstructionRepo.get(caseId);
    if (existing?.narrativeEditedAt) return "skipped-edited";

    await CaseReconstructionSvc.generate(caseId, userId);
    return existing ? "regenerated" : "generated";
  }

  /** Fast, synchronous half of a queued generate — access check + claiming the
   * AiGenerationJob row — called from the controller before handing off to
   * AiGenerationQueue, so a 403/409 surfaces immediately instead of after an enqueue. Unlike
   * `generate`, only used by the lawyer-triggered HTTP endpoint — case-post-extraction.ts's
   * automatic post-upload generation keeps calling `generate` directly, since it awaits the
   * finished narrative. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "caseReconstruction");
  }

  /** Run by AiGenerationQueue's worker after beginQueued has already claimed the job row. The
   * pane's Regenerate covers the whole pane: the narrative, the scenes and the event chain side by
   * side (Storyboard is a view of the scenes). Scenes read the timeline, not the narrative's text,
   * but need its row to exist — so only a case's very first narrative makes them wait for it; a
   * regenerate keeps the row's id and never touches `scenes`. The job stands or falls on the
   * narrative; scenes and events run under their own locks, so each tab still shows its own run
   * and failure. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseReconstruction", async () => {
      const scenesNow = !!(await CaseReconstructionRepo.get(caseId));
      const scenes = () => CaseReconstructionSvc.followOn(caseId, "scenes", () => CaseReconstructionSvc.generateScenes(caseId, userId));
      const alongside = [
        CaseReconstructionSvc.followOn(caseId, "events", () => CaseReconstructionSvc.generateEvents(caseId, userId)),
        ...(scenesNow ? [scenes()] : []),
      ];
      try {
        // The lawyer's Regenerate (even over their own edits): the "What changed" modal then
        // describes this run (CaseChangeRun).
        await CaseChangeRun.regenerate(
          caseId,
          userId,
          "reconstruction",
          () => CaseReconstructionRepo.get(caseId),
          () => CaseReconstructionSvc.generateInner(caseId, userId),
          (before, after) => diffReconstruction(before, after, before ? "regenerated" : "generated"),
        );
      } finally {
        await Promise.all(alongside);
      }
      if (!scenesNow) await scenes();
    });
  }

  /** Scenes or events run as part of a bigger run: a 409 (that tab's own Generate is already
   * running) or a failure is logged, never thrown, so it can't fail the narrative's run. */
  private static async followOn(caseId: string, name: "scenes" | "events", fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) {
        logger.info(`Case reconstruction: ${name} already running, skipped`, { caseId });
        return;
      }
      logger.warn(`Case reconstruction: ${name} failed`, { err, caseId });
    }
  }

  private static async generateInner(caseId: string, userId?: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) throw new HttpError("No indexed documents to reconstruct from yet", 422);

    const buildCaseReconstructionPrompt = getCaseReconstructionPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseReconstructionPrompt(ready, ukJurisdiction)}

${wrapExtractedText("Use only these excerpts and the attached case documents.", pack.text)}
`;

    // A single blocking REST call (callChatWonderRest) waits for the entire response before
    // returning — a multi-paragraph, three-register narrative can take long enough to
    // generate that Cloudflare's edge proxy (in front of Chat Wonder) times the connection
    // out (524) before it finishes, independent of any timeout set in this app's own HTTP
    // client. The streaming WS path avoids that — same fix as RedTeamSvc.generate.
    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseReconstruction", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    }

    const registers = extractRegisterNarratives(result.content);
    const gaps = extractReconstructionGaps(result.content) ?? [];
    // Only meaningful alongside a well-formed [NARRATIVE] block — the untagged fallback below
    // has no reliable text for a [CLAIMS] block's quotes to be matched against anyway.
    const claims = registers ? extractReconstructionClaims(result.content) : undefined;

    // Fall back to treating the whole cleaned response as the general narrative if the model
    // didn't use the expected tags — mirrors how CaseStrategySvc tolerates an untagged reply
    // instead of hard-failing.
    const data = registers
      ? {
          narrative: cleanRegister(registers.narrative),
          narrativeCourt: registers.court ? cleanRegister(registers.court) : null,
          narrativeOpposing: registers.opposing ? cleanRegister(registers.opposing) : null,
          gaps,
          claims,
        }
      : { narrative: cleanRegister(result.content), narrativeCourt: null, narrativeOpposing: null, gaps, claims: undefined };

    logger.info("Chat Wonder case reconstruction reply", {
      caseId,
      readyCount: ready.length,
      narrativeChars: data.narrative.length,
      hasCourtVersion: !!data.narrativeCourt,
      hasOpposingVersion: !!data.narrativeOpposing,
      gapCount: gaps.length,
      claimCount: claims?.length ?? 0,
    });
    if (!data.narrative) throw new HttpError("Chat Wonder returned no reconstruction text", 502);

    const row = await CaseReconstructionRepo.upsert(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generate", payload: { id: row.id } });
    return CaseReconstructionRepo.get(caseId);
  }

  /** Editing any of the three registers is allowed. */
  static async update(
    caseId: string,
    userId: string,
    data: { narrative?: string; narrativeCourt?: string; narrativeOpposing?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CaseReconstructionRepo.get(caseId);
    const row = await CaseReconstructionRepo.updateFields(caseId, data);
    if (!row) throw new HttpError("Case reconstruction not found — generate one first", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.update", payload: { id: row.id } });
    await ManualEditLog.record(caseId, userId, {
      pane: "caseReconstruction",
      kind: "narrative",
      itemId: row.id,
      action: "edited",
      label: "Case narrative",
      changes: fieldChanges(before, data, { narrative: "text", narrativeCourt: "text", narrativeOpposing: "text" }),
    });
    return CaseReconstructionRepo.get(caseId);
  }

  // ── Grounded Reconstruction, Rungs 1-2 (differentiation program, Phase 3 — Workstream C) ──

  /** Rung 1 — its own action (the Scenes tab's Generate) and lock, also run by the pane's
   * Regenerate (runQueued) and by the analysis refresh (autoGenerateScenes). Requires a
   * narrative to already exist (scenes are built from the case's timeline/evidence, not from
   * re-reading the narrative, but there's nothing to reconstruct scenes "of" without one). */
  static async generateScenes(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstructionScenes", () => CaseReconstructionSvc.generateScenesInner(caseId, userId));
  }

  /** The analysis refresh's scenes step. Scenes are rebuilt even over an edited narrative — they
   * come from the timeline and the documents, not its text — but need one to exist, so a case
   * whose first narrative failed is skipped rather than refused. */
  static async autoGenerateScenes(caseId: string, userId: string): Promise<{ skipped: boolean }> {
    if (!(await CaseReconstructionRepo.get(caseId))) return { skipped: true };
    await CaseReconstructionSvc.generateScenes(caseId, userId);
    return { skipped: false };
  }

  static async beginQueuedScenes(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "caseReconstructionScenes");
  }

  static async runQueuedScenes(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseReconstructionScenes", () =>
      CaseReconstructionSvc.generateScenesInner(caseId, userId),
    );
  }

  private static async generateScenesInner(caseId: string, userId?: string) {
    const existing = await CaseReconstructionRepo.get(caseId);
    if (!existing) throw new HttpError("Generate the case reconstruction narrative first", 422);

    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) throw new HttpError("No indexed documents to build scenes from yet", 422);

    const timeline = await CaseTimelineRepo.list(caseId);
    const timelineBlock =
      timeline
        .map((e) => `- ${e.occurredOn ? e.occurredOn.toISOString() : "undated"}: ${e.title}${e.description ? ` — ${e.description}` : ""}`)
        .join("\n") || "(no timeline events recorded yet)";
    const docsBlock = ready.map((d) => `- \`${d.id}\` — ${d.name}`).join("\n");
    const pack = await buildFactExcerptPack(ready);

    const prompt = `[legal ai]

## ROLE
You reconstruct one key episode from this case's timeline as an ordered scene script — the same events the narrative already covers, broken into individually-sourced beats a lawyer can rehearse and hear read aloud.

## TASK
Pick the single most consequential episode on the timeline below (the one the case turns on) and break it into scenes: time, location, who's present, what happens, and any dialogue the documents actually record. Every element must trace to a document — if you can't pin down a time, an actor's identity, or what was said, say so in that scene's "unresolved" list instead of guessing.

## TIMELINE
${timelineBlock}

## DOCUMENTS
${docsBlock}

${wrapExtractedText("Source every scene and quote from these excerpts.", pack.text)}

## OUTPUT
Reply with exactly this block and nothing else:

[SCENES]
[{"index": 0, "time": "...", "location": "...", "actors": ["..."], "action": "...", "dialogue": [{"actor": "...", "line": "..."}], "sourceRefs": [{"docId": "...", "page": 12, "quote": "a verbatim substring copied character-for-character from the EXTRACTED TEXT above"}], "confidence": "high|medium|low", "unresolved": ["..."]}]
[/SCENES]

Cap at 20 scenes. Every sourceRef's "quote" must be copied verbatim from EXTRACTED TEXT — never paraphrase. Omit "quote" (or "dialogue") rather than inventing one you can't source. Order scenes chronologically starting at index 0.`;

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseScenes", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    }

    const raw = parseRawScenes(result.content);
    if (!raw) throw new HttpError("Chat Wonder returned no usable scene script", 502);

    const readyDocIds = new Set(ready.map((d) => d.id));
    const corpusByDocId = new Map<string, string>();
    for (const doc of ready) {
      const chunkIds = await DocumentChunkRepo.findIdsByDocument(doc.id);
      const rows = await DocumentChunkRepo.findTextsByIds(chunkIds);
      corpusByDocId.set(doc.id, rows.map((r) => r.chunkText).join(" ").slice(0, 20000));
    }
    const scenes = auditScenes(raw, readyDocIds, corpusByDocId);

    // Each unresolved item is investigation work, so it becomes a Case Strategy to-do linked to
    // its scene — not a Weakness: many are gaps in the other side's case. Deduped against every
    // to-do already on the case (open or ticked) so regenerating scenes doesn't spam duplicates
    // or reopen work. Not tagged AI: a Case Strategy refresh prunes AI to-dos it didn't write.
    const existingTodos = new Set(
      (await ProceduralDeadlineRepo.listProcedureItems(caseId)).map((item) => item.label.trim().toLowerCase()),
    );
    for (const scene of scenes) {
      for (const item of scene.unresolved) {
        const key = item.trim().toLowerCase();
        if (!key || existingTodos.has(key)) continue;
        existingTodos.add(key);
        await ProceduralDeadlineRepo.createProcedureItem(caseId, {
          kind: "TODO",
          label: item.trim(),
          sourceLabel: scene.time || scene.location || null,
          sourceKind: "SCENE",
          sourceId: existing.id,
          sourceKey: String(scene.index),
        });
      }
    }

    logger.info("Chat Wonder case reconstruction scenes reply", { caseId, sceneCount: scenes.length });

    await CaseReconstructionRepo.updateScenes(caseId, scenes);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generateScenes", payload: { sceneCount: scenes.length } });
    return CaseReconstructionRepo.get(caseId);
  }

  /** The dated event chain: each event a factual proposition with one source quote checked against
   * the document, then — when USE_JEV_RECONSTRUCTION is on — a Verified / Disputed / Unverified
   * status from Jev (see reconstruction-event-assess.ts). Its own action, like scenes, and built from
   * the case's documents alone: it does not need the narrative and is stored in its own table. */
  static async generateEvents(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstructionEvents", () => CaseReconstructionSvc.generateEventsInner(caseId, userId));
  }

  /** Refuses before the job is queued, so the lawyer gets the answer in the response — with what to
   * fill in or wait for — rather than a job that fails later. */
  static async beginQueuedEvents(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await CaseReconstructionSvc.assertEventPrerequisites(caseId);
    await AiGenerationLockSvc.begin(caseId, "caseReconstructionEvents");
  }

  /** 422 naming every missing prerequisite (see reconstruction-prerequisites.ts): `message` reads as
   * a sentence, `blockers` lets a client list them. Returns the documents it loaded so the caller needn't. */
  private static async assertEventPrerequisites(caseId: string) {
    const docs = await DocumentRepo.listAllByCase(caseId);
    const blockers = findEventBlockers({ documents: docs.map((d) => ({ name: d.name, ragStatus: d.ragStatus })) });
    if (blockers.length) throw new HttpError(blockersMessage(blockers), 422, "EVENT_PREREQUISITES", { blockers });
    return { docs };
  }

  static async runQueuedEvents(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseReconstructionEvents", () =>
      CaseReconstructionSvc.generateEventsInner(caseId, userId),
    );
  }

  private static async generateEventsInner(caseId: string, userId?: string) {
    // Checked again here, not just when queued: documents can change between the request and the job.
    const { docs } = await CaseReconstructionSvc.assertEventPrerequisites(caseId);
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));

    // Every date in every chunk, not just the sampled excerpt pack — the chain is seeded from these.
    const facts: BundleFact[] = [];
    for (const doc of ready) {
      const chunks = await DocumentChunkRepo.findTextsByIds(await DocumentChunkRepo.findIdsByDocument(doc.id));
      // UK bundles write 03/04/2024 as 3 April; PH (and US-style) documents as March 4.
      facts.push(...extractBundleFacts(chunks, { numericDayFirst: tenantCode === "UK" }));
    }
    const pack = await buildFactExcerptPack(ready);
    const prompt = buildCaseReconstructionEventsPrompt({
      docs: ready,
      anchors: buildDateAnchorPack(facts, new Map(ready.map((d) => [d.id, d.name]))),
      excerpts: pack.text,
    });

    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseEvents", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    }

    const raw = parseRawEvents(result.content);
    if (!raw) throw new HttpError("Chat Wonder returned no usable event chain", 502);

    // Full text, not scenes' 20,000-character cut: a quote from late in a long document must still resolve.
    const fullTextByDocId = await DocumentChunkRepo.findFullTextsByDocuments(ready.map((d) => d.id));
    const { events: audited, dropped } = auditEventsDetailed(raw, new Set(ready.map((d) => d.id)), fullTextByDocId);
    if (dropped.length) {
      // A dropped quote costs a real event its Verified badge; this is how the cause gets found
      // (cosmetic / wrong document / paraphrase — see diagnoseDroppedQuote).
      logger.warn("Case reconstruction events: source quotes dropped", { caseId, dropped: dropped.length, of: raw.length, byKind: summariseDrops(dropped) });
      for (const d of dropped.slice(0, 10)) logger.info("Case reconstruction events: dropped quote", { caseId, ...d, quote: d.quote?.slice(0, 200) });
    }
    const events = isJevReconstructionEnabled()
      ? await assessEvents(audited, { facts, fullTextByDocId, docNames: new Map(ready.map((d) => [d.id, d.name])) }, { classifyPhrasing: classifyEventPhrasingWithJev, checkAssertion: checkAssertionWithJev })
      : markUnchecked(audited);

    logger.info("Case reconstruction events", {
      caseId,
      eventCount: events.length,
      droppedQuotes: dropped.length,
      sourced: events.filter((e) => e.sourceRef).length,
      jev: isJevReconstructionEnabled(),
      verified: events.filter((e) => e.status === "VERIFIED").length,
      disputed: events.filter((e) => e.status === "DISPUTED").length,
    });

    await CaseReconstructionEventsRepo.upsert(caseId, events);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generateEvents", payload: { eventCount: events.length } });
    return CaseReconstructionEventsRepo.get(caseId);
  }
}
