import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
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
import { fetchOfficialText, FetchedOfficialText } from "../utils/citation-source-text";
import { OfficialTextSource } from "@prisma/client";
import HttpError from "../utils/http-error";
import { TenantCode } from "../types/tenant-code";
import { ResolvedCitationAuthority } from "../types/citation-check.types";

/** How the change log names a citation: its reference, else the start of the quoted text. */
function citationLabel(row: { citedReference: string | null; quotedText: string }): string {
  return row.citedReference || (row.quotedText.length > 80 ? `${row.quotedText.slice(0, 80)}…` : row.quotedText);
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

    let officialText = body.officialText?.trim() || null;
    let officialTextSource: OfficialTextSource | null = officialText ? "LAWYER" : null;
    if (!officialText && body.legalRagId) {
      // The legalRagId corpus is PH-only (see legal/legal-knowledge-provider.ts) — never read it
      // for a non-PH case, even though the id itself isn't secret/tenant-scoped data.
      if (tenantCode !== "PH") {
        throw new HttpError("legalRagId citations require the PH case-law corpus, not available for this case's tenantCode", 400);
      }
      const id = BigInt(body.legalRagId);
      const doc = await LegalRagRepo.findById(id).catch(() => null);
      officialText = doc?.full_text ?? doc?.formatted_markdown ?? null;
      if (officialText) officialTextSource = "PH_LAW";
    }

    const evaluated = await CitationCheckSvc.evaluate(
      {
        quotedText: body.quotedText,
        citedReference: body.citedReference,
        officialText,
        officialTextSource,
        officialTextRef: null,
        pinpoint: body.pinpoint,
      },
      tenantCode,
    );

    const row = await CitationCheckRepo.create(caseId, {
      quotedText: body.quotedText,
      citedReference: body.citedReference ?? null,
      sourceUrl: body.sourceUrl ?? null,
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

    const quotedText = body.quotedText?.trim() || existing.quotedText;
    const citedReference = body.citedReference === undefined ? existing.citedReference : body.citedReference?.trim() || null;

    // The official text (#364). A fetched passage was chosen for the old quote and reference, so it's
    // fetched again when either changes. The edit form prefills whatever is stored, so the fetched
    // passage coming back unchanged isn't the lawyer's text; anything else they send is.
    const wasFetched = !!existing.officialTextSource && existing.officialTextSource !== "LAWYER";
    const sentText = body.officialText === undefined ? undefined : body.officialText?.trim() || null;
    let officialText: string | null;
    let officialTextSource: OfficialTextSource | null;
    let officialTextRef: string | null;
    if (sentText === undefined || (wasFetched && sentText === existing.officialText)) {
      const stale = wasFetched && (quotedText !== existing.quotedText || citedReference !== existing.citedReference);
      officialText = stale ? null : existing.officialText;
      officialTextSource = stale ? null : existing.officialTextSource;
      officialTextRef = stale ? null : existing.officialTextRef;
    } else {
      officialText = sentText;
      officialTextSource = sentText ? "LAWYER" : null;
      officialTextRef = null;
    }

    const merged = {
      quotedText,
      citedReference,
      sourceUrl: body.sourceUrl === undefined ? existing.sourceUrl : body.sourceUrl?.trim() || null,
      officialText,
    };
    // An untouched pinpoint isn't carried over: the quote or reference may have changed, and a
    // stale auto-detected pinpoint would then point at the wrong passage. Only a lawyer-typed one
    // (sent with the edit) is kept; otherwise it's re-detected exactly as on a new check.
    const evaluated = await CitationCheckSvc.evaluate(
      { ...merged, officialTextSource, officialTextRef, pinpoint: body.pinpoint },
      tenantCode,
    );

    const row = await CitationCheckRepo.update(id, caseId, { ...merged, ...evaluated.fields });
    if (!row) throw new HttpError("Citation not found", 404);

    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.update", payload: { id, status: row.status } });
    await ManualEditLog.record(caseId, userId, {
      pane: "law",
      kind: "citation",
      itemId: id,
      action: "edited",
      label: citationLabel(row),
      changes: fieldChanges(existing, body, { quotedText: "text", citedReference: "value", sourceUrl: "value", officialText: "text", pinpoint: "value" }),
    });
    return { ...row, resolvedAuthority: evaluated.authority };
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CitationCheckRepo.findInCase(id, caseId);
    const deleted = await CitationCheckRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Citation not found", 404);
    if (before) await ManualEditLog.record(caseId, userId, { pane: "law", kind: "citation", itemId: id, action: "removed", label: citationLabel(before) });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.delete", payload: { id } });
  }

  /** The verification shared by a new check and an edit. When there's no official text, it's
   * fetched from the authority the citation resolves to (#364) before checking — see
   * citation-source-text.ts. */
  private static async evaluate(
    input: {
      quotedText: string;
      citedReference?: string | null;
      officialText: string | null;
      officialTextSource: OfficialTextSource | null;
      officialTextRef: string | null;
      pinpoint?: string | null;
    },
    tenantCode: TenantCode,
  ) {
    const citedReference = input.citedReference ?? undefined;
    // Separate from the quote-vs-source text match below: does the cited authority itself
    // actually exist? Reuses the same resolution engine Citation Map uses (LawSvc.search for
    // PH, the UK Legal MCP for UK) rather than a new verification path — resolving here means
    // Citation Map's own lazy resolution (CitationMapSvc.getSeed) finds it already done.
    const resolved = await CitationCheckSvc.resolveAuthority(citedReference, tenantCode);

    let { officialText, officialTextSource, officialTextRef } = input;
    let fetched: FetchedOfficialText | null = null;
    if (!officialText && resolved.lawId) {
      fetched = await fetchOfficialText({ tenantCode, lawId: resolved.lawId, quote: input.quotedText, ukSection: resolved.ukSection });
      if (fetched) {
        officialText = fetched.text;
        officialTextSource = fetched.source;
        officialTextRef = fetched.ref;
      }
    }

    // A lawyer-typed pinpoint always wins; then the paragraph the fetch found; then, for a
    // resolved UK judgment, a search of its text.
    const pinpointPromise = input.pinpoint?.trim()
      ? Promise.resolve(input.pinpoint.trim())
      : fetched?.pinpoint
        ? Promise.resolve(fetched.pinpoint)
        : detectPinpoint(resolved.lawId, input.quotedText);

    const [result, proposition, pinpoint] = await Promise.all([
      evaluateCitation({ quotedText: input.quotedText, officialText, citedReference }),
      classifyProposition(input.quotedText, officialText, tenantCode),
      pinpointPromise,
    ]);

    // Say where the text came from, or why there wasn't any — the lawyer should be able to see
    // what the check was (or wasn't) based on.
    let notes = result.notes;
    if (fetched) notes = `Checked against ${fetched.label}. ${result.notes}`;
    else if (!officialText && resolved.lawId) {
      notes = `Couldn't load the text of ${resolved.authority?.title ?? "the cited authority"} to check against. Paste the source passage under Add details to check it.`;
    }

    return {
      fields: {
        officialText,
        officialTextSource,
        officialTextRef,
        status: result.status,
        notes,
        resolvedLawId: resolved.lawId,
        resolutionConfidence: resolved.confidence,
        pinpoint,
        propositionType: proposition?.type ?? null,
      },
      authority: resolved.authority,
    };
  }

  static async resolveAuthority(
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
    const ukSection = tenantCode === "UK" ? ((resolved as { section?: string | null }).section ?? null) : null;
    return { lawId: resolved.lawId, confidence: resolved.confidence, authority, ukSection };
  }
}
