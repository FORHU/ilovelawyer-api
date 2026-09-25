import CaseAccess from "../utils/case-access";
import CitationCheckRepo from "../repositories/citation-check.repository";
import { evaluateCitation } from "../utils/citation-validity";
import LegalRagRepo from "../repositories/legal-rag.repository";
import LawRepo from "../repositories/law.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { resolveCitationToLaw } from "../utils/citation-resolution";
import { resolveUkCitationToLaw } from "../utils/uk-citation-resolution";
import { parseCitedReference } from "./citation-map.service";
import { classifyProposition } from "../utils/citation-proposition";
import { detectPinpoint } from "../utils/citation-pinpoint";
import HttpError from "../utils/http-error";
import { TenantCode } from "../types/tenant-code";
import { ResolvedCitationAuthority } from "../types/citation-check.types";

export default class CitationCheckSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CitationCheckRepo.list(caseId);
  }

  static async check(
    caseId: string,
    userId: string,
    body: {
      quotedText: string;
      citedReference?: string;
      sourceUrl?: string;
      officialText?: string;
      legalRagId?: string;
      pinpoint?: string;
    },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);

    let officialText = body.officialText ?? null;
    if (!officialText && body.legalRagId) {
      // The legalRagId corpus is PH-only (see legal/legal-knowledge-provider.ts) — never read it
      // for a non-PH case, even though the id itself isn't secret/tenant-scoped data.
      if (tenantCode !== "PH") {
        throw new HttpError("legalRagId citations require the PH case-law corpus, not available for this case's tenantCode", 400);
      }
      const id = BigInt(body.legalRagId);
      const doc = await LegalRagRepo.findById(id).catch(() => null);
      officialText = doc?.full_text ?? doc?.formatted_markdown ?? null;
    }

    const evaluated = await CitationCheckSvc.evaluate(
      { quotedText: body.quotedText, citedReference: body.citedReference, officialText, pinpoint: body.pinpoint },
      tenantCode,
    );

    const row = await CitationCheckRepo.create(caseId, {
      quotedText: body.quotedText,
      citedReference: body.citedReference ?? null,
      sourceUrl: body.sourceUrl ?? null,
      officialText,
      ...evaluated.fields,
    });

    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.check", payload: { id: row.id, status: row.status } });
    return { ...row, resolvedAuthority: evaluated.authority };
  }

  /** Edits an existing citation. A field left out (undefined) is kept; "" or null clears it.
   * Every edit re-runs the same verification a new check gets (validity, authority resolution,
   * proposition type, pinpoint) — otherwise the stored status and authority link would describe
   * the old text, not what the lawyer just saved. */
  static async update(
    caseId: string,
    id: string,
    userId: string,
    body: {
      quotedText?: string;
      citedReference?: string | null;
      sourceUrl?: string | null;
      officialText?: string | null;
      pinpoint?: string | null;
    },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await CitationCheckRepo.findInCase(id, caseId);
    if (!existing) throw new HttpError("Citation not found", 404);
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);

    const merged = {
      quotedText: body.quotedText?.trim() || existing.quotedText,
      citedReference: body.citedReference === undefined ? existing.citedReference : body.citedReference?.trim() || null,
      sourceUrl: body.sourceUrl === undefined ? existing.sourceUrl : body.sourceUrl?.trim() || null,
      officialText: body.officialText === undefined ? existing.officialText : body.officialText?.trim() || null,
    };
    // An untouched pinpoint isn't carried over: the quote or reference may have changed, and a
    // stale auto-detected pinpoint would then point at the wrong passage. Only a lawyer-typed one
    // (sent with the edit) is kept; otherwise it's re-detected exactly as on a new check.
    const evaluated = await CitationCheckSvc.evaluate({ ...merged, pinpoint: body.pinpoint }, tenantCode);

    const row = await CitationCheckRepo.update(id, caseId, { ...merged, ...evaluated.fields });
    if (!row) throw new HttpError("Citation not found", 404);

    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.update", payload: { id, status: row.status } });
    return { ...row, resolvedAuthority: evaluated.authority };
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CitationCheckRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Citation not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.delete", payload: { id } });
  }

  /** The verification shared by a new check and an edit. */
  private static async evaluate(
    input: { quotedText: string; citedReference?: string | null; officialText: string | null; pinpoint?: string | null },
    tenantCode: TenantCode,
  ) {
    const citedReference = input.citedReference ?? undefined;
    // Separate from the quote-vs-source text match below: does the cited authority itself
    // actually exist? Reuses the same resolution engine Citation Map uses (LawSvc.search for
    // PH, the UK Legal MCP for UK) rather than a new verification path — resolving here means
    // Citation Map's own lazy resolution (CitationMapSvc.getSeed) finds it already done.
    const [result, resolved] = await Promise.all([
      evaluateCitation({ quotedText: input.quotedText, officialText: input.officialText, citedReference }),
      CitationCheckSvc.resolveAuthority(citedReference, tenantCode),
    ]);

    // Both computed before the row is saved so the check is persisted whole — a lawyer-typed
    // pinpoint always wins over the auto-detected one, which only fires for a resolved UK judgment.
    const [proposition, pinpoint] = await Promise.all([
      classifyProposition(input.quotedText, input.officialText, tenantCode),
      input.pinpoint?.trim() ? Promise.resolve(input.pinpoint.trim()) : detectPinpoint(resolved.lawId, input.quotedText),
    ]);

    return {
      fields: {
        status: result.status,
        notes: result.notes,
        resolvedLawId: resolved.lawId,
        resolutionConfidence: resolved.confidence,
        pinpoint,
        propositionType: proposition?.type ?? null,
      },
      authority: resolved.authority,
    };
  }

  private static async resolveAuthority(
    citedReference: string | undefined,
    tenantCode: TenantCode,
  ): Promise<ResolvedCitationAuthority> {
    if (!citedReference || (tenantCode !== "PH" && tenantCode !== "UK")) {
      return { lawId: null, confidence: null, authority: null };
    }

    const resolved =
      tenantCode === "UK"
        ? await resolveUkCitationToLaw(citedReference)
        : await resolveCitationToLaw(parseCitedReference(citedReference));

    if (!resolved) return { lawId: null, confidence: null, authority: null };

    const law = await LawRepo.findById(resolved.lawId);
    const authority = law ? { lawId: law.id, title: law.title, jurisUrl: law.jurisUrl } : null;
    return { lawId: resolved.lawId, confidence: resolved.confidence, authority };
  }
}
