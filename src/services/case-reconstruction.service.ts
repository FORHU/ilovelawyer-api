import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getCaseReconstructionPromptBuilder } from "../legal/prompt-registry";
import { extractRegisterNarratives, extractReconstructionGaps } from "../utils/case-reconstruction-parse";
import { extractReconstructionClaims } from "../utils/case-reconstruction-claims-parse";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";
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
}
