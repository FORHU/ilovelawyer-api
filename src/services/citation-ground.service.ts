import { GroundRole, Prisma } from "@prisma/client";
import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import CitationCheckRepo from "../repositories/citation-check.repository";
import CitationGroundRepo, { AiCitationGroundRow } from "../repositories/citation-ground.repository";
import LawRepo from "../repositories/law.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import { buildCitationGroundsPrompt } from "../constants/citation-grounds.constants";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { extractCitationGrounds } from "../utils/citation-grounds-parse";
import { checkCitationGroundWithJev, CitationGroundJevInput, isCitationGroundJevEnabled } from "../utils/citation-ground-jev";
import { isUniqueConstraintError } from "../utils/ai-generation-lock.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

type Claim = Awaited<ReturnType<typeof CaseClaimRepo.list>>[number];
type Check = Awaited<ReturnType<typeof CitationCheckRepo.list>>[number];

/** The Jev input for one authority → claim link. `titles` maps a resolved law id to its title.
 * Exported for scripts/jev-citation-grounds-benchmark.ts, so a harvest records the same input. */
export function jevInput(check: Check, claim: Claim, role: GroundRole, titles: Map<string, string>): CitationGroundJevInput {
  return {
    authority: {
      reference: check.citedReference ?? "",
      title: check.resolvedLawId ? (titles.get(check.resolvedLawId) ?? null) : null,
      quotedText: check.quotedText,
      officialText: check.officialText,
    },
    claim: { title: claim.title, causeOfAction: claim.causeOfAction, description: claim.description },
    role,
  };
}

export async function resolvedTitles(checks: Check[]): Promise<Map<string, string>> {
  const laws = await LawRepo.findManyByIds(checks.map((c) => c.resolvedLawId).filter((id): id is string => !!id));
  return new Map(laws.map((law) => [law.id, law.title]));
}

/**
 * The Citation Map's list view: which pleaded claim (CaseClaim) each of the case's cited
 * authorities (CitationCheck) attaches to. "Map authorities" is a queued job (AiGenerationQueue
 * kind "citationGrounds") that asks Chat Wonder for the links and, with USE_JEV_CITATION_GROUNDS
 * on, has Jev check each one; the lawyer can also add or remove links by hand.
 */
export default class CitationGroundSvc {
  /** Claims and links for the Citation Map seed response. */
  static async forSeed(caseId: string) {
    const [claims, grounds] = await Promise.all([CaseClaimRepo.list(caseId), CitationGroundRepo.list(caseId)]);
    return {
      claims: claims.map((c) => ({
        id: c.id,
        title: c.title,
        causeOfAction: c.causeOfAction,
        source: c.source,
        sourceLabel: c.sourceLabel,
        sourceQuote: c.sourceQuote,
      })),
      grounds: grounds.map((g) => ({
        id: g.id,
        citationCheckId: g.citationCheckId,
        claimId: g.claimId,
        role: g.role,
        source: g.source,
        reason: g.reason,
        jev: g.jev,
      })),
    };
  }

  /** Fast half of the queued action. Refuses up front when there's nothing to map. */
  static async beginQueuedMap(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    const [claims, checks] = await Promise.all([CaseClaimRepo.list(caseId), CitationCheckRepo.list(caseId)]);
    if (claims.length === 0) throw new HttpError("Add or find the case's claims before mapping authorities to them.", 409);
    if (!checks.some((c) => c.citedReference)) throw new HttpError("The case has no cited authorities to map yet.", 409);
    await AiGenerationLockSvc.begin(caseId, "citationGrounds");
  }

  /** Run by AiGenerationQueue's worker after beginQueuedMap has claimed the job row. */
  static async runQueuedMap(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "citationGrounds", () => CitationGroundSvc.map(caseId, userId));
  }

  private static async map(caseId: string, userId: string) {
    const [claims, allChecks, header, tenantCode] = await Promise.all([
      CaseClaimRepo.list(caseId),
      CitationCheckRepo.list(caseId),
      CaseRepo.findPromptHeader(caseId),
      CaseAccess.resolveTenantCode(caseId),
    ]);
    const checks = allChecks.filter((c) => c.citedReference);
    if (claims.length === 0 || checks.length === 0) return CitationGroundRepo.replaceAi(caseId, []);
    const titles = await resolvedTitles(checks);

    const prompt = buildCitationGroundsPrompt({
      jurisdictionLabel: tenantCode === "UK" ? (header?.ukJurisdiction ?? "England and Wales") : "the Philippines",
      caseName: header?.caseName ?? "Untitled case",
      claims: claims.map((c) => ({ id: c.id, title: c.title, causeOfAction: c.causeOfAction })),
      authorities: checks.map((c) => ({
        id: c.id,
        reference: c.citedReference!,
        title: c.resolvedLawId ? (titles.get(c.resolvedLawId) ?? null) : null,
        quotedText: c.quotedText,
      })),
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
    const proposed = extractCitationGrounds(result.content, new Set(checks.map((c) => c.id)), new Set(claims.map((c) => c.id)));
    if (proposed === undefined) throw new HttpError("Chat Wonder returned no [GROUNDS] block", 502);

    const rows = await CitationGroundSvc.verify(proposed, checks, claims, titles);
    const saved = await CitationGroundRepo.replaceAi(caseId, rows);
    logger.info("Citation grounds: mapped", { caseId, proposed: proposed.length, saved: rows.length, jev: isCitationGroundJevEnabled() });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citationGrounds.map", payload: { count: rows.length } });
    return saved;
  }

  /** With the flag on, Jev checks each proposed link: DOES_NOT_APPLY links are dropped, the rest
   * keep Jev's read. A failed check keeps the link unchecked. Never throws. */
  static async verify(
    proposed: { citationCheckId: string; claimId: string; role: GroundRole; reason: string | null }[],
    checks: Check[],
    claims: Claim[],
    titles: Map<string, string>,
  ): Promise<AiCitationGroundRow[]> {
    if (!isCitationGroundJevEnabled()) return proposed;
    const checkById = new Map(checks.map((c) => [c.id, c]));
    const claimById = new Map(claims.map((c) => [c.id, c]));
    const verified = await Promise.all(
      proposed.map(async (link): Promise<AiCitationGroundRow | null> => {
        try {
          const jev = await checkCitationGroundWithJev(
            jevInput(checkById.get(link.citationCheckId)!, claimById.get(link.claimId)!, link.role, titles),
          );
          if (jev.attaches === "DOES_NOT_APPLY") return null;
          return { ...link, jev: asJson(jev), jevCheckedAt: new Date() };
        } catch (err) {
          logger.warn("Citation grounds: Jev check failed for one link, keeping it unchecked", { err, ...link });
          return link;
        }
      }),
    );
    return verified.filter((row): row is AiCitationGroundRow => row !== null);
  }

  /** A lawyer-added link. Checked by Jev when the flag is on — a DOES_NOT_APPLY read is kept and
   * shown as a flag, never used to refuse the lawyer's link. */
  static async createManual(caseId: string, userId: string, data: { citationCheckId: string; claimId: string; role: GroundRole }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const [claims, checks] = await Promise.all([CaseClaimRepo.list(caseId), CitationCheckRepo.list(caseId)]);
    const claim = claims.find((c) => c.id === data.claimId);
    const check = checks.find((c) => c.id === data.citationCheckId);
    if (!claim || !check) throw new HttpError("Claim or citation not found", 404);

    let row;
    try {
      row = await CitationGroundRepo.createManual(caseId, data);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new HttpError("That authority is already linked to that claim.", 409);
      throw err;
    }
    if (isCitationGroundJevEnabled()) {
      try {
        const jev = await checkCitationGroundWithJev(jevInput(check, claim, data.role, await resolvedTitles([check])));
        row = await CitationGroundRepo.setJevCheck(row.id, asJson(jev));
      } catch (err) {
        logger.warn("Citation grounds: Jev check failed for a manual link", { err, caseId, id: row.id });
      }
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citationGround.create", payload: { id: row.id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CitationGroundRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Link not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citationGround.delete", payload: { id } });
  }
}
