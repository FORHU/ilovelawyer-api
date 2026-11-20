import ClientCaseSvc, { type ClientWorkspace } from "./client-case.service";
import ClientIntakeSvc from "./client-intake.service";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import { buildCaseSummaryDocument, caseSummaryFilename, type SummaryLang } from "../utils/client-case-summary-document";
import { renderCaseSummaryToPdf } from "../utils/client-case-summary-pdf-renderer";

/**
 * The client's "Download case summary" (ilovelawyer-client#137): GET /api/client/cases/:caseId/export.
 *
 * Built at download time from the stored intake — ClientIntakeSvc.get is a plain read, so this never
 * starts an AI run and never spends credits. Sent straight back rather than stored: unlike the
 * lawyer's Case Brief (CaseBriefExportSvc) there is no preview or history to serve it again, and a
 * stored copy would be one more file of the client's to find and delete with their account.
 *
 * Any of the client's own cases (404 for anyone else's, like every /api/client route); a lawyer
 * account never gets this far (requireClientAccount).
 */
export default class ClientCaseSummarySvc {
  static async exportPdf(workspace: ClientWorkspace, userId: string, caseId: string, lang: SummaryLang): Promise<{ buffer: Buffer; filename: string }> {
    const found = await ClientCaseSvc.get(workspace, caseId);
    const intake = await ClientIntakeSvc.get(workspace, caseId);

    // Same rule as the client app's summaryAvailability: a run in flight would date the file the
    // moment it saved, and with nothing saved there's nothing to summarise.
    if (intake.status === "RUNNING") {
      throw new HttpError("Your overview is still being prepared. Try again in a moment.", 409, "INTAKE_RUNNING");
    }
    if (!intake.generatedAt) {
      throw new HttpError("There's nothing to put in a case summary yet. Tell us about your case in the chat first.", 409, "INTAKE_EMPTY");
    }

    const summary = buildCaseSummaryDocument({
      title: found.title,
      areas: found.areas.map((a) => a.name),
      ukJurisdiction: found.ukJurisdiction,
      outsideUk: found.outsideUk,
      where: found.where,
      notes: found.notes,
      documentNames: found.documents.map((d) => d.name),
      intake,
      tenantCode: workspace.tenantCode,
      lang,
    });
    const buffer = await renderCaseSummaryToPdf(summary);

    await SecurityAuditSvc.record({
      action: "export.case_summary",
      actorId: userId,
      targetType: "case",
      targetId: caseId,
      caseId,
      payload: { format: "pdf", lang, intakeStatus: intake.status, bytes: buffer.length },
    });

    return { buffer, filename: caseSummaryFilename(found.title, new Date(), workspace.tenantCode) };
  }
}
