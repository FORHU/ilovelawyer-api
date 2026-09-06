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

export interface ResolvedAuthority {
  lawId: string;
  title: string;
  jurisUrl: string;
}

interface ResolvedCitationAuthority {
  lawId: string | null;
  confidence: number | null;
  authority: ResolvedAuthority | null;
}

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

    const result = evaluateCitation({
      quotedText: body.quotedText,
      officialText,
      citedReference: body.citedReference,
    });

    // Separate from the quote-vs-source text match above: does the cited authority itself
    // actually exist? Reuses the same resolution engine Citation Map uses (LawSvc.search for
    // PH, the UK Legal MCP for UK) rather than a new verification path — resolving here means
    // Citation Map's own lazy resolution (CitationMapSvc.getSeed) finds it already done.
    const resolved = await CitationCheckSvc.resolveAuthority(body.citedReference, tenantCode);

    // Both computed before the row is created so the check is persisted whole — a lawyer-typed
    // pinpoint always wins over the auto-detected one, which only fires for a resolved UK judgment.
    const [proposition, pinpoint] = await Promise.all([
      classifyProposition(body.quotedText, officialText, tenantCode),
      body.pinpoint?.trim() ? Promise.resolve(body.pinpoint.trim()) : detectPinpoint(resolved.lawId, body.quotedText),
    ]);

    const row = await CitationCheckRepo.create(caseId, {
      quotedText: body.quotedText,
      citedReference: body.citedReference ?? null,
      sourceUrl: body.sourceUrl ?? null,
      officialText,
      status: result.status,
      notes: result.notes,
      resolvedLawId: resolved.lawId,
      resolutionConfidence: resolved.confidence,
      pinpoint,
      propositionType: proposition?.type ?? null,
    });

    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.check", payload: { id: row.id, status: row.status } });
    return { ...row, resolvedAuthority: resolved.authority };
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
