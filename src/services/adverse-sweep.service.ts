import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import CitationCheckRepo from "../repositories/citation-check.repository";
import CitationEdgeRepo from "../repositories/citation-edge.repository";
import AdverseCitationHitRepo, { NewAdverseHit } from "../repositories/adverse-citation-hit.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseFindingSvc from "./case-finding.service";
import {
  AdverseCitationJevCheck,
  checkAdverseCitationWithJev,
  isAdverseSweepJevEnabled,
  isSuggestedAsWeakness,
} from "../utils/adverse-citation-jev";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const asJson = (value: unknown) => value as Prisma.InputJsonValue;
const MAX_WEAKNESS_LABEL = 160;
const TREATMENT_WORD = { OVERRULED: "overruled", ABANDONED: "abandoned", DISTINGUISHED: "distinguished" } as Record<string, string>;

type Check = Awaited<ReturnType<typeof CitationCheckRepo.list>>[number];
type Hit = Awaited<ReturnType<typeof AdverseCitationHitRepo.list>>[number];

function referenceOf(check: Pick<Check, "citedReference">): string {
  return check.citedReference ?? "Cited authority";
}

/** The Weakness a lawyer gets when they accept a hit. Lawyer-authored (no AI note), so a case
 * refresh never replaces it. */
function weaknessFor(hit: Hit, check: Check): { label: string; detail: string } {
  const label =
    hit.kind === "OWN_STATUS"
      ? `${referenceOf(check)} may not support what it's cited for`
      : `${referenceOf(check)} was ${TREATMENT_WORD[hit.treatment ?? ""] ?? "treated negatively"} in ${hit.citingTitle ?? "a later decision"}`;
  return { label: label.slice(0, MAX_WEAKNESS_LABEL), detail: "Find other authority, or distinguish it" };
}

/**
 * The Citation Map's adverse-citation sweep: for every authority the case cites that resolved
 * into the Law corpus, the later decisions in that corpus that overruled, abandoned or
 * distinguished it (CitationEdge, looked up by the authority they point at), plus any authority
 * the case's own citation check marked ADVERSE. With USE_JEV_ADVERSE_SWEEP on, Jev reads each
 * treatment against what the case cites the authority for.
 *
 * Only ever suggests — a hit worth a Weakness (isSuggestedAsWeakness) waits for the lawyer to
 * accept it (creating the Weakness) or dismiss it. It can only see edges already extracted into
 * the corpus, so a clean sweep means "nothing in the indexed corpus", not "good law".
 */
export default class AdverseSweepSvc {
  /** Fast half of the queued action. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    const checks = await CitationCheckRepo.list(caseId);
    if (!checks.some((c) => c.citedReference)) throw new HttpError("The case has no cited authorities to sweep yet.", 409);
    await AiGenerationLockSvc.begin(caseId, "adverseSweep");
  }

  /** Run by AiGenerationQueue's worker after beginQueued has claimed the job row. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "adverseSweep", () => AdverseSweepSvc.sweep(caseId, userId));
  }

  static async sweep(caseId: string, userId: string) {
    const checks = (await CitationCheckRepo.list(caseId)).filter((c) => c.citedReference);
    const resolved = checks.filter((c) => c.resolvedLawId);
    const edges = await CitationEdgeRepo.listNegativeTreatmentsOf(resolved.map((c) => c.resolvedLawId!));
    const useJev = isAdverseSweepJevEnabled();

    const hits: NewAdverseHit[] = checks
      .filter((c) => c.status === "ADVERSE")
      .map((c) => ({ citationCheckId: c.id, kind: "OWN_STATUS", edgeId: null, treatment: null, citingTitle: null, excerpt: c.notes }));
    const treatmentHits = await Promise.all(
      resolved.flatMap((check) =>
        edges
          .filter((e) => e.toLawId === check.resolvedLawId)
          .map(async (edge): Promise<NewAdverseHit> => {
            const citingTitle = edge.fromLaw.caseNumber ? `${edge.fromLaw.title} (${edge.fromLaw.caseNumber})` : edge.fromLaw.title;
            const hit: NewAdverseHit = {
              citationCheckId: check.id,
              kind: "NEGATIVE_TREATMENT",
              edgeId: edge.id,
              treatment: edge.treatment,
              citingTitle,
              excerpt: edge.excerpt,
            };
            if (!useJev) return hit;
            try {
              const jev = await checkAdverseCitationWithJev({
                authority: { reference: referenceOf(check), citedFor: check.quotedText },
                treatment: edge.treatment,
                citingDecision: citingTitle,
                excerpt: edge.excerpt,
              });
              return { ...hit, jev: asJson(jev), jevCheckedAt: new Date() };
            } catch (err) {
              logger.warn("Adverse sweep: Jev check failed for one hit, keeping it unchecked", { err, caseId, edgeId: edge.id });
              return hit;
            }
          }),
      ),
    );

    const saved = await AdverseCitationHitRepo.replace(caseId, [...hits, ...treatmentHits]);
    await CaseRepo.markAdverseSwept(caseId);
    logger.info("Adverse sweep: done", {
      caseId,
      authorities: checks.length,
      inCorpus: resolved.length,
      hits: saved.length,
      suggested: saved.filter((h) => AdverseSweepSvc.suggested(h)).length,
    });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citationMap.adverseSweep", payload: { hits: saved.length } });
    return saved;
  }

  static suggested(hit: Hit): boolean {
    return isSuggestedAsWeakness({ kind: hit.kind, treatment: hit.treatment, jev: hit.jev as AdverseCitationJevCheck | null });
  }

  /** The sweep block of the Citation Map seed. `inCorpus` is how many authorities the sweep could
   * actually check — the rest never resolved into the corpus. */
  static async forSeed(caseId: string) {
    const [row, checks, hits] = await Promise.all([
      prisma.case.findUnique({ where: { id: caseId }, select: { adverseSweptAt: true } }),
      CitationCheckRepo.list(caseId),
      AdverseCitationHitRepo.list(caseId),
    ]);
    const cited = checks.filter((c) => c.citedReference);
    return {
      sweep: {
        sweptAt: row?.adverseSweptAt?.toISOString() ?? null,
        authorities: cited.length,
        inCorpus: cited.filter((c) => c.resolvedLawId).length,
        hits: hits.map((h) => ({
          id: h.id,
          citationCheckId: h.citationCheckId,
          kind: h.kind,
          treatment: h.treatment,
          citingTitle: h.citingTitle,
          excerpt: h.excerpt,
          jev: h.jev,
          suggested: AdverseSweepSvc.suggested(h),
          suggestionStatus: h.suggestionStatus,
          weaknessId: h.weaknessId,
        })),
      },
    };
  }

  /** The lawyer accepts a suggested hit: it becomes a Weakness (MATERIAL — it can take an
   * authority out from under a claim), and the hit remembers which. */
  static async accept(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const hit = await AdverseCitationHitRepo.find(id, caseId);
    if (!hit) throw new HttpError("Adverse hit not found", 404);
    if (hit.suggestionStatus === "ACCEPTED") return hit;
    const check = (await CitationCheckRepo.list(caseId)).find((c) => c.id === hit.citationCheckId);
    if (!check) throw new HttpError("Citation not found", 404);
    const weakness = await CaseFindingSvc.create(caseId, userId, { category: "WEAKNESS", tag: "MATERIAL", ...weaknessFor(hit, check) });
    return AdverseCitationHitRepo.setDecision(id, "ACCEPTED", weakness.id);
  }

  static async dismiss(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const hit = await AdverseCitationHitRepo.find(id, caseId);
    if (!hit) throw new HttpError("Adverse hit not found", 404);
    const row = await AdverseCitationHitRepo.setDecision(id, "DISMISSED", hit.weaknessId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citationMap.adverseDismiss", payload: { id } });
    return row;
  }
}
