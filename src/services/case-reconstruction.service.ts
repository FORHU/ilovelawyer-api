import { randomUUID } from "crypto";
import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import FilesRepo from "../repositories/files.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getCaseReconstructionPromptBuilder } from "../legal/prompt-registry";
import { extractRegisterNarratives, extractReconstructionGaps } from "../utils/case-reconstruction-parse";
import { extractReconstructionClaims } from "../utils/case-reconstruction-claims-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
import { parseRawScenes, auditScenes, Scene } from "../utils/case-reconstruction-scenes-parse";
import { castForCase } from "../utils/table-read-voices";
import { mergeCastTurnsToMp3, CastTurn } from "../utils/audio-overview-render";
import { uploadToS3 } from "../utils/s3";
import { AI_FINDING_NOTE, CASE_RECONSTRUCTION_TABLE_READ_OUTPUT_PREFIX } from "../constants";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";
import { cleanRegister } from "../utils/case-reconstruction.utils";

export default class CaseReconstructionSvc {
  static async get(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseReconstructionRepo.get(caseId);
  }

  /** A dedicated action, not folded into CaseRefreshSvc.refresh — narrative generation is a
   * heavier, slower single-shot call than the short tagged-list prompts refresh already runs,
   * so it's the lawyer's call when to (re)generate rather than happening on every refresh.
   * userId is optional so case-post-extraction.ts's background job can call this once
   * documents finish indexing — same pattern as CaseStrategySvc.generateFromDocuments. */
  static async generate(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstruction", () => CaseReconstructionSvc.generateInner(caseId, userId));
  }

  /** Fast, synchronous half of a queued generate — access check + claiming the
   * AiGenerationJob row — called from the controller before handing off to
   * AiGenerationQueue, so a 403/409 surfaces immediately instead of after an enqueue. Unlike
   * `generate`, only used by the lawyer-triggered HTTP endpoint — case-post-extraction.ts's
   * automatic post-upload generation keeps calling `generate` directly, since it awaits the
   * finished narrative before chaining CaseReconstructionAudioSvc.startAudioJob. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "caseReconstruction");
  }

  /** Run by AiGenerationQueue's worker after beginQueued has already claimed the job row. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseReconstruction", () =>
      CaseReconstructionSvc.generateInner(caseId, userId),
    );
  }

  private static async generateInner(caseId: string, userId?: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const docs = await DocumentRepo.listAllByCase(caseId);
    const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
    if (ready.length < 1) throw new HttpError("No indexed documents to reconstruct from yet", 422);

    const buildCaseReconstructionPrompt = getCaseReconstructionPromptBuilder(tenantCode);
    const pack = await buildFactExcerptPack(ready);
    const prompt = `${buildCaseReconstructionPrompt(ready)}

## EXTRACTED TEXT
Use only these excerpts and the attached case documents.

${pack.text || "(no indexed text)"}
`;

    // A single blocking REST call (callChatWonderRest) waits for the entire response before
    // returning — a multi-paragraph, three-register narrative can take long enough to
    // generate that Cloudflare's edge proxy (in front of Chat Wonder) times the connection
    // out (524) before it finishes, independent of any timeout set in this app's own HTTP
    // client. The streaming WS path avoids that — same fix as RedTeamSvc.generate.
    const grounding = { caseDocumentIds: ready.map((d) => d.id), caseDocumentChunkIds: pack.chunkIds };
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, grounding, undefined, tenantCode);
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

    const existing = await CaseReconstructionRepo.get(caseId);
    const row = await CaseReconstructionRepo.upsert(caseId, data);
    if (existing?.audioFileId) {
      await CaseReconstructionRepo.updateAudio(caseId, { audioStaleAt: new Date() });
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generate", payload: { id: row.id } });
    return CaseReconstructionRepo.get(caseId);
  }

  /** Editing any of the three registers is allowed — but only editing the General narrative
   * (the one audio is synthesized from) marks existing audio stale. Editing Court/Opposing
   * text doesn't touch what the lawyer is actually listening to. */
  static async update(
    caseId: string,
    userId: string,
    data: { narrative?: string; narrativeCourt?: string; narrativeOpposing?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await CaseReconstructionRepo.get(caseId);
    const row = await CaseReconstructionRepo.updateFields(caseId, data);
    if (!row) throw new HttpError("Case reconstruction not found — generate one first", 404);
    if (data.narrative !== undefined && existing?.audioFileId) {
      await CaseReconstructionRepo.updateAudio(caseId, { audioStaleAt: new Date() });
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.update", payload: { id: row.id } });
    return CaseReconstructionRepo.get(caseId);
  }

  // ── Grounded Reconstruction, Rungs 1-2 (differentiation program, Phase 3 — Workstream C) ──

  /** Rung 1 — a dedicated action, not folded into `generate()`: a lawyer may want the narrative
   * without paying for a scene script. Requires a narrative to already exist (scenes are built
   * from the case's timeline/evidence, not from re-reading the narrative, but there's nothing
   * to reconstruct scenes "of" without one). */
  static async generateScenes(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstructionScenes", () => CaseReconstructionSvc.generateScenesInner(caseId, userId));
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

## EXTRACTED TEXT
${pack.text || "(no indexed text)"}

## OUTPUT
Reply with exactly this block and nothing else:

[SCENES]
[{"index": 0, "time": "...", "location": "...", "actors": ["..."], "action": "...", "dialogue": [{"actor": "...", "line": "..."}], "sourceRefs": [{"docId": "...", "page": 12, "quote": "a verbatim substring copied character-for-character from the EXTRACTED TEXT above"}], "confidence": "high|medium|low", "unresolved": ["..."]}]
[/SCENES]

Cap at 20 scenes. Every sourceRef's "quote" must be copied verbatim from EXTRACTED TEXT — never paraphrase. Omit "quote" (or "dialogue") rather than inventing one you can't source. Order scenes chronologically starting at index 0.`;

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
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

    // Each unresolved item becomes investigation work (a Weakness), deduped against what's
    // already there so regenerating scenes doesn't spam duplicates — same "AI" tag convention
    // as CaseFindingAiSvc, but additive-only (never replaces/deletes) since these aren't the
    // sole source of truth for Weaknesses the way a full Refresh's batch is.
    const existingWeaknesses = new Set((await CaseFindingRepo.list(caseId, "WEAKNESS")).map((f) => f.label.trim().toLowerCase()));
    for (const scene of scenes) {
      for (const item of scene.unresolved) {
        const key = item.trim().toLowerCase();
        if (!key || existingWeaknesses.has(key)) continue;
        existingWeaknesses.add(key);
        await CaseFindingRepo.create(caseId, {
          category: "WEAKNESS",
          label: item,
          notes: AI_FINDING_NOTE,
          sourceLabel: scene.time || scene.location || null,
        });
      }
    }

    logger.info("Chat Wonder case reconstruction scenes reply", { caseId, sceneCount: scenes.length });

    await CaseReconstructionRepo.updateScenes(caseId, scenes);
    if (existing.tableReadFileId) {
      await CaseReconstructionRepo.updateTableRead(caseId, { tableReadStaleAt: new Date() });
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generateScenes", payload: { sceneCount: scenes.length } });
    return CaseReconstructionRepo.get(caseId);
  }

  /** Rung 2 — multi-voice audio rendered from `scenes` (one Polly voice per actor, a narrator
   * for action lines) via Audio Overview's synthesize-many-short-turns + ffmpeg-concat pipeline
   * generalized to N voices — see mergeCastTurnsToMp3. Requires scenes to exist first. */
  static async generateTableRead(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    return AiGenerationLockSvc.run(caseId, "caseReconstructionTableRead", () =>
      CaseReconstructionSvc.generateTableReadInner(caseId, userId),
    );
  }

  static async beginQueuedTableRead(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "caseReconstructionTableRead");
  }

  static async runQueuedTableRead(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseReconstructionTableRead", () =>
      CaseReconstructionSvc.generateTableReadInner(caseId, userId),
    );
  }

  private static async generateTableReadInner(caseId: string, userId?: string) {
    const existing = await CaseReconstructionRepo.get(caseId);
    if (!existing) throw new HttpError("Case reconstruction not found — generate one first", 404);
    const scenes = (existing.scenes as unknown as Scene[] | null) ?? [];
    if (scenes.length === 0) throw new HttpError("No scenes to read yet — generate the scene script first", 422);

    const actorNames = [...new Set(scenes.flatMap((s) => s.actors))];
    const cast = castForCase(caseId, actorNames);

    const turns: CastTurn[] = [];
    for (const scene of scenes) {
      const intro = [scene.time, scene.location, scene.action].filter(Boolean).join(". ");
      if (intro) turns.push({ text: intro, voiceId: cast.NARRATOR! });
      for (const line of scene.dialogue) {
        turns.push({ text: `${line.actor}: ${line.line}`, voiceId: cast[line.actor] ?? cast.NARRATOR! });
      }
    }
    if (turns.length === 0) throw new HttpError("Scenes have no narratable content", 422);

    logger.info("Table read: rendering started", { caseId, sceneCount: scenes.length, turnCount: turns.length, castSize: Object.keys(cast).length });
    const merged = await mergeCastTurnsToMp3(turns);

    const key = `${CASE_RECONSTRUCTION_TABLE_READ_OUTPUT_PREFIX}${caseId}-${randomUUID()}.mp3`;
    const fileUrl = await uploadToS3(key, merged, "audio/mpeg");
    const file = await FilesRepo.create(`case-reconstruction-table-read-${caseId}.mp3`, fileUrl, key);

    await CaseReconstructionRepo.updateTableRead(caseId, { tableReadFileId: file.id, tableReadStatus: "COMPLETED", tableReadStaleAt: null });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "reconstruction.generateTableRead", payload: { fileId: file.id } });
    logger.info("Table read: rendering completed", { caseId, fileId: file.id });
    return CaseReconstructionRepo.get(caseId);
  }
}
