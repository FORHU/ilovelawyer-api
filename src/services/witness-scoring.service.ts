import CaseAccess from "../utils/case-access";
import CaseSnapshotSvc from "./case-snapshot.service";
import WitnessRepo from "../repositories/witness.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import { getWitnessScoringPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { extractWitnessFactors, quoteAppearsIn, type WitnessFactorRow } from "../utils/witness-scoring-parse";
import { FACTOR_KEYS, RUBRIC_VERSION, scoreWitness, type FactorKey } from "../utils/witness-rubric";
import { classifyWitnessWithJev, isWitnessJevEnabled, type JevFactors } from "../utils/witness-rubric-jev";
import { buildNeeds } from "../utils/witness-needs";
import { parseOverrides, resolveFactors } from "../utils/witness-factor-resolve";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const MAX_EXCERPT = 160;
// Per-document and total caps on the sponsored-document text sent to the model, so a witness
// with a very long affidavit (or a case with many sponsored documents) can't blow the prompt.
const MAX_DOC_CHARS = 4000;
const MAX_TOTAL_DOC_CHARS = 40000;
// What one witness's documents may contribute to another witness's Jev request (corroboration).
const MAX_OTHER_DOC_CHARS = 1500;

function formatDay(value?: string | Date | null): string {
  if (!value) return "undated";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

function clip(text: string): string {
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

/**
 * AI-proposed witness credibility. Writes only the ai* columns on Witness — never `status`,
 * `credibility` or `credibilityOverride` — so a lawyer's manual score/status always wins and
 * re-scoring can't overwrite it. Built entirely from CaseSnapshotSvc.get(), same as RedTeamSvc:
 * the model sees only what's already recorded on the case.
 */
export default class WitnessScoringSvc {
  /** Fast, synchronous half — access check, at least one witness, claim the job row. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    if ((await WitnessRepo.list(caseId)).length === 0) {
      throw new HttpError("Add at least one witness before scoring.", 400);
    }
    await AiGenerationLockSvc.begin(caseId, "witnessScoring");
  }

  /** Run by AiGenerationQueue's worker after beginQueued has claimed the job row. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "witnessScoring", () => WitnessScoringSvc.scoreInner(caseId, userId));
  }

  private static async scoreInner(caseId: string, userId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const snapshot = await CaseSnapshotSvc.get(caseId, userId);
    if (snapshot.witnesses.length === 0) return;

    const docNameById = new Map(snapshot.documents.map((d) => [d.id, d.name]));
    const contradictions = snapshot.evidence.contradictions;

    const sponsoredDocIds = [
      ...new Set(snapshot.evidence.matrix.filter((m) => m.sponsoringWitnessId).map((m) => m.documentId)),
    ];
    const fullTexts = await DocumentChunkRepo.findFullTextsByDocuments(sponsoredDocIds);
    const perDocChars = Math.max(
      500,
      Math.min(MAX_DOC_CHARS, Math.floor(MAX_TOTAL_DOC_CHARS / Math.max(1, sponsoredDocIds.length))),
    );

    const witnesses = snapshot.witnesses.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      summary: w.summary,
      statementReceived: w.statementReceived,
      sponsoredEvidence: snapshot.evidence.matrix
        .filter((item) => item.sponsoringWitnessId === w.id)
        .map((item) => ({
          name: docNameById.get(item.documentId) ?? "Unnamed document",
          hearsay: item.hearsayCategory,
          excerpt: fullTexts.get(item.documentId)?.slice(0, perDocChars),
          contradictions: contradictions
            .filter((c) => c.leftDocumentId === item.documentId || c.rightDocumentId === item.documentId)
            .map((c) => `"${clip(c.leftExcerpt)}" vs "${clip(c.rightExcerpt)}"`),
        })),
    }));

    const buildPrompt = getWitnessScoringPromptBuilder(tenantCode);
    const prompt = buildPrompt({
      caseName: snapshot.case.caseName,
      actionType: snapshot.case.actionType,
      jurisdiction: snapshot.case.jurisdiction,
      ukJurisdiction: snapshot.case.ukJurisdiction,
      witnesses,
      timeline: snapshot.timeline.map((t) => ({ title: t.title, occurredOn: t.occurredOn })),
    });

    // Streaming WS path, not the blocking REST call — same reason as RedTeamSvc (Cloudflare 524).
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    }

    const rows = extractWitnessFactors(result.content, new Set(witnesses.map((w) => w.id)));
    logger.info("Chat Wonder witness scoring reply", { caseId, rowCount: rows?.length ?? 0 });
    const useJev = isWitnessJevEnabled();
    // Without Jev the quotes and answers are all there is; with it Chat Wonder only supplies quotes.
    if (!useJev && (!rows || rows.length === 0)) throw new HttpError("Chat Wonder returned no witness scores", 502);
    const rowById = new Map((rows ?? []).map((r) => [r.witnessId, r]));

    // Everything the model was shown, so a quoted passage can be checked against a real source.
    const corpus: { name: string; text: string }[] = [
      ...[...fullTexts].map(([id, text]) => ({ name: docNameById.get(id) ?? "Unnamed document", text })),
      ...contradictions.map((c) => ({ name: "Contradiction", text: `${c.leftExcerpt} ${c.rightExcerpt}` })),
      ...snapshot.timeline.map((t) => ({ name: "Timeline", text: t.title })),
    ];
    const checkQuote = (quote: string) => {
      const hit = corpus.find((c) => quoteAppearsIn(quote, c.text));
      return { verified: !!hit, documentName: hit?.name ?? null };
    };

    const stored = new Map((await WitnessRepo.list(caseId)).map((w) => [w.id, w]));
    const timeline = snapshot.timeline.map((t) => ({ date: formatDay(t.occurredOn), title: t.title }));

    const scoredAt = new Date();
    await Promise.all(
      witnesses.map(async (w) => {
        const row: WitnessFactorRow | undefined = rowById.get(w.id);
        const emptyFactors = Object.fromEntries(
          FACTOR_KEYS.map((k) => [k, { answer: null, quote: null, document: null }]),
        ) as WitnessFactorRow["factors"];

        let jev: JevFactors | null = null;
        if (useJev) {
          try {
            jev = await classifyWitnessWithJev({
              witness: { name: w.name, role: w.role ?? null, summary: w.summary ?? null, statementReceived: w.statementReceived },
              sponsoredDocuments: w.sponsoredEvidence.map((e) => ({
                name: e.name,
                hearsay: e.hearsay,
                text: e.excerpt ?? null,
                contradictions: e.contradictions,
              })),
              otherWitnesses: witnesses
                .filter((o) => o.id !== w.id)
                .map((o) => ({
                  name: o.name,
                  documents: o.sponsoredEvidence.map((e) => ({ name: e.name, text: e.excerpt?.slice(0, MAX_OTHER_DOC_CHARS) ?? null })),
                })),
              timeline,
            });
          } catch (err) {
            logger.warn("Witness scoring: Jev failed, using Chat Wonder's answers", { err, witnessId: w.id });
          }
        }

        const overrides = parseOverrides(stored.get(w.id)?.factorOverrides);
        const { answers, audit } = resolveFactors(row?.factors ?? emptyFactors, jev, overrides, checkQuote);
        const rubric = scoreWitness(answers, w.statementReceived);
        const reasons = row?.reasons ?? [];
        const needs = buildNeeds({
          statementReceived: w.statementReceived,
          sponsoredDocumentCount: w.sponsoredEvidence.length,
          answers,
          aiNeeds: row?.needs ?? {},
        });
        // Rows are only written when there is something to show for the witness.
        if (!row && !jev) return;

        await WitnessRepo.saveAiScore(w.id, caseId, {
          aiCredibility: rubric.score,
          aiRationale: reasons,
          aiSuggestedStatus: rubric.suggestedStatus,
          aiFactors: {
            factors: audit,
            earned: rubric.earned,
            assessable: rubric.assessable,
            band: rubric.band,
            flags: rubric.flags,
            insufficientReason: rubric.insufficientReason,
            needs,
          },
          aiRubricVersion: RUBRIC_VERSION,
          scoredAt,
        });
      }),
    );
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "witness.score",
      payload: { count: witnesses.length, rubricVersion: RUBRIC_VERSION, jev: useJev },
    });
  }
}
