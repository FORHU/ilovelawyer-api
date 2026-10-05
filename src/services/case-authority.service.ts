import CaseAccess from "../utils/case-access";
import CaseAuthorityRepo, { CaseAuthorityInput } from "../repositories/case-authority.repository";
import CitationCheckSvc from "./citation-check.service";
import LawRepo from "../repositories/law.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { suggestAuthorityStance } from "../utils/authority-stance-jev";
import HttpError from "../utils/http-error";

export default class CaseAuthoritySvc {
  static async create(
    caseId: string,
    userId: string,
    data: Omit<CaseAuthorityInput, "resolvedLawId" | "source" | "jevStance" | "jevConfidence">,
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const groundLabel = await CaseAuthoritySvc.assertGround(caseId, data.findingId);

    // Same PH/UK resolution the quote checker uses — the panel links to the source when it resolves.
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const resolved = await CitationCheckSvc.resolveAuthority(data.citation ?? undefined, tenantCode);

    // Jev's second opinion on the stance (null when its flag is off or the call fails — the row is
    // saved either way, and the lawyer's own stance is never overwritten).
    const law = resolved.lawId ? await LawRepo.findById(resolved.lawId) : null;
    const jev = await suggestAuthorityStance({
      ground: groundLabel,
      title: data.title,
      subtitle: data.subtitle,
      citation: data.citation,
      rationale: data.rationale,
      lawText: law ? [law.summary, law.facts, law.disposition].filter(Boolean).join("\n\n") : null,
    });

    const row = await CaseAuthorityRepo.create(caseId, {
      ...data,
      resolvedLawId: resolved.lawId,
      source: "MANUAL",
      jevStance: jev?.stance ?? null,
      jevConfidence: jev?.confidence ?? null,
    });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "authority.create", payload: { id: row.id, stance: row.stance } });
    return { ...row, resolvedAuthority: resolved.authority };
  }

  static async update(
    caseId: string,
    id: string,
    userId: string,
    data: Partial<Pick<CaseAuthorityInput, "stance" | "title" | "subtitle" | "citation" | "rationale" | "findingId">>,
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    await CaseAuthoritySvc.assertGround(caseId, data.findingId);

    // An emptied optional box is stored as null, not "".
    const patch: Parameters<typeof CaseAuthorityRepo.update>[2] = { ...data };
    for (const key of ["subtitle", "citation", "rationale"] as const) {
      if (patch[key] === "") patch[key] = null;
    }

    // A changed citation may now point at a different law (or none) — re-resolve it the same way
    // create does, so the panel's source link follows the edit. Resolved only when the citation
    // was sent, so a stance-only change never re-runs the lookup.
    let resolvedAuthority: Awaited<ReturnType<typeof CitationCheckSvc.resolveAuthority>>["authority"] | undefined;
    if (data.citation !== undefined) {
      const tenantCode = await CaseAccess.resolveTenantCode(caseId);
      const resolved = await CitationCheckSvc.resolveAuthority(patch.citation ?? undefined, tenantCode);
      patch.resolvedLawId = resolved.lawId;
      resolvedAuthority = resolved.authority;
    }

    const row = await CaseAuthorityRepo.update(id, caseId, patch);
    if (!row) throw new HttpError("Authority not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "authority.update", payload: { id } });
    return resolvedAuthority === undefined ? row : { ...row, resolvedAuthority };
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseAuthorityRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Authority not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "authority.delete", payload: { id } });
  }

  /** Returns the ground's label, or null when no ground was given. */
  private static async assertGround(caseId: string, findingId: string | null | undefined) {
    if (!findingId) return null;
    const label = await CaseAuthorityRepo.findGroundLabel(findingId, caseId);
    if (!label) throw new HttpError("findingId must be a legal issue on this case", 400);
    return label;
  }
}
