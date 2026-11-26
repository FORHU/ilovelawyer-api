import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientCaseSvc, { type ClientCaseChanges, type NewClientCase } from "../services/client-case.service";
import CaseAreaSvc from "../services/case-area.service";
import ClientOverviewSvc from "../services/client-overview.service";
import ClientCaseOverviewSvc from "../services/client-case-overview.service";
import ClientIntakeSvc from "../services/client-intake.service";
import ClientBillingSvc from "../services/client-billing.service";
import ClientCaseSummarySvc from "../services/client-case-summary.service";
import ClientStorySvc from "../services/client-story.service";
import ClientQuestionsSvc, { type AnswerVia } from "../services/client-questions.service";
import ClientEvidenceSvc from "../services/client-evidence.service";
import HttpError from "../utils/http-error";
import { contentDisposition } from "../utils/content-disposition";
import { ALLOWED_DOCUMENT_EXTENSIONS, DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../constants";
import {
  addClientDocumentSchema,
  answerClientQuestionSchema,
  correctClientStorySchema,
  dismissEvidenceSuggestionSchema,
  documentNoteSchema,
  skipClientQuestionSchema,
  createClientCaseSchema,
  exportClientCaseSummarySchema,
  presignClientDocumentSchema,
  presignVoiceMessageSchema,
  quoteClientTopUpSchema,
  sendClientMessageSchema,
  sendVoiceMessageSchema,
  startClientStorySchema,
  topUpClientCaseSchema,
  updateClientCaseSchema,
} from "../validation/client-case.validation";

function validate<T>(schema: ObjectSchema<T>, body: unknown): T {
  const { error, value } = schema.validate(body, { stripUnknown: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** `area`, from an app that predates several areas per case, as a list of one. */
function withAreas<T extends { area?: string; areas?: string[] }>({ area, ...rest }: T): Omit<T, "area"> {
  return area === undefined ? rest : { ...rest, areas: [area] };
}

/** The client app's case routes. requireClientAccount has already set the request's workspace to the
 * client's personal workspace. */
export default class ClientCaseCtrl {
  static async list(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.list(clientWorkspaceOf(req), req.query.archived === "true"));
  }

  /** What the app tells the client before they upload: the file types and size the API accepts. */
  static async limits(_req: Request, res: Response) {
    res.status(200).json({ upload: { extensions: ALLOWED_DOCUMENT_EXTENSIONS, maxBytes: DOCUMENT_UPLOAD_BATCH_MAX_BYTES } });
  }

  static async get(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  /** The "Type of issue" choices: the switched-on case areas, in order. */
  /** The client's own site's list: a KR client picks from KR's areas. */
  static async caseAreas(req: Request, res: Response) {
    res.status(200).json(await CaseAreaSvc.listActive(clientWorkspaceOf(req).tenantCode));
  }

  static async create(req: Request, res: Response) {
    // The schema needs one of areas or area, so withAreas always leaves areas set.
    const input = withAreas(validate<NewClientCase & { area?: string }>(createClientCaseSchema, req.body));
    res.status(201).json(await ClientCaseSvc.create(clientWorkspaceOf(req), req.user.userId, input));
  }

  /** The story-first way in: makes the case from the client's story and starts reading it. 202, as
   * the reading finishes in the background (poll GET .../intake). */
  static async startStory(req: Request, res: Response) {
    const { text } = validate<{ text: string }>(startClientStorySchema, req.body);
    res.status(202).json(await ClientStorySvc.start(clientWorkspaceOf(req), req.user.userId, text));
  }

  /** The story's key facts, as chips for the screen while it's read. */
  static async storyFacts(req: Request, res: Response) {
    res.status(200).json(await ClientStorySvc.facts(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  /** "Something's not right": the client's fix to the story, read together with it. */
  static async correctStory(req: Request, res: Response) {
    const { text } = validate<{ text: string }>(correctClientStorySchema, req.body);
    res.status(202).json(await ClientStorySvc.correct(clientWorkspaceOf(req), req.user.userId, req.params.caseId, text));
  }

  /** The Questions step: starts the case's questions (writing the list once), or picks them up
   * where the client left off. */
  static async startQuestions(req: Request, res: Response) {
    res.status(200).json(await ClientQuestionsSvc.start(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  /** The evidence step: the proof suggested for the case, written once with the AI. */
  static async startEvidence(req: Request, res: Response) {
    res.status(200).json(await ClientEvidenceSvc.start(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  /** The proof suggested for the case, without writing any (null when there's none yet). */
  static async evidence(req: Request, res: Response) {
    res.status(200).json(await ClientEvidenceSvc.read(clientWorkspaceOf(req), req.params.caseId));
  }

  /** The client's own note on one of their documents. */
  static async setDocumentNote(req: Request, res: Response) {
    const { note } = validate<{ note: string }>(documentNoteSchema, req.body);
    res.status(200).json(await ClientEvidenceSvc.setNote(clientWorkspaceOf(req), req.params.caseId, req.params.documentId, note));
  }

  /** The evidence step's Done: reads the case once over the new proof. */
  static async evidenceDone(req: Request, res: Response) {
    res.status(200).json(await ClientEvidenceSvc.done(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  /** "I don't have this" on a suggestion, or taking it back. */
  static async dismissEvidence(req: Request, res: Response) {
    const { dismissed } = validate<{ dismissed: boolean }>(dismissEvidenceSuggestionSchema, req.body);
    res.status(200).json(await ClientEvidenceSvc.setDismissed(clientWorkspaceOf(req), req.params.caseId, req.params.suggestionId, dismissed));
  }

  /** Where the case's questions are, without starting them (null when there's no list). */
  static async questions(req: Request, res: Response) {
    res.status(200).json(await ClientQuestionsSvc.read(clientWorkspaceOf(req), req.params.caseId));
  }

  /** The client's answer to the question they're on. */
  static async answerQuestion(req: Request, res: Response) {
    const input = validate<{ questionId: string; text: string; via: AnswerVia }>(answerClientQuestionSchema, req.body);
    res.status(200).json(await ClientQuestionsSvc.answer(clientWorkspaceOf(req), req.user.userId, req.params.caseId, input));
  }

  /** "I don't know, skip". */
  static async skipQuestion(req: Request, res: Response) {
    const input = validate<{ questionId: string; text?: string }>(skipClientQuestionSchema, req.body);
    res.status(200).json(await ClientQuestionsSvc.skip(clientWorkspaceOf(req), req.user.userId, req.params.caseId, input));
  }

  static async update(req: Request, res: Response) {
    const input = withAreas(validate<ClientCaseChanges & { area?: string }>(updateClientCaseSchema, req.body));
    res.status(200).json(await ClientCaseSvc.update(clientWorkspaceOf(req), req.user.userId, req.params.caseId, input));
  }

  static async archive(req: Request, res: Response) {
    await ClientCaseSvc.archive(clientWorkspaceOf(req), req.user.userId, req.params.caseId);
    res.status(204).end();
  }

  static async unarchive(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.unarchive(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async remove(req: Request, res: Response) {
    await ClientCaseSvc.remove(clientWorkspaceOf(req), req.user.userId, req.params.caseId);
    res.status(204).end();
  }

  static async listMessages(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.listMessages(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async sendMessage(req: Request, res: Response) {
    const { text, documentIds } = validate(sendClientMessageSchema, req.body);
    res.status(202).json(await ClientCaseSvc.sendMessage(clientWorkspaceOf(req), req.user.userId, req.params.caseId, text, documentIds));
  }

  static async cancelMessage(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.cancelMessage(clientWorkspaceOf(req), req.user.userId, req.params.caseId, req.params.messageId));
  }

  static async deleteMessage(req: Request, res: Response) {
    await ClientCaseSvc.deleteMessage(clientWorkspaceOf(req), req.params.caseId, req.params.messageId);
    res.status(204).end();
  }

  static async presignDocument(req: Request, res: Response) {
    const file = validate(presignClientDocumentSchema, req.body);
    res.status(200).json(await ClientCaseSvc.presignDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, file));
  }

  static async presignVoiceMessage(req: Request, res: Response) {
    const { contentType, fileSize } = validate(presignVoiceMessageSchema, req.body);
    res.status(200).json(await ClientCaseSvc.presignVoiceMessage(clientWorkspaceOf(req), req.params.caseId, contentType, fileSize));
  }

  static async sendVoiceMessage(req: Request, res: Response) {
    const { key } = validate(sendVoiceMessageSchema, req.body);
    res.status(202).json(await ClientCaseSvc.sendVoiceMessage(clientWorkspaceOf(req), req.user.userId, req.params.caseId, key));
  }

  static async addDocument(req: Request, res: Response) {
    const file = validate(addClientDocumentSchema, req.body);
    res.status(201).json(await ClientCaseSvc.addDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, file));
  }

  static async removeDocument(req: Request, res: Response) {
    await ClientCaseSvc.removeDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, req.params.documentId);
    res.status(204).end();
  }

  static async documentUrl(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.documentUrl(clientWorkspaceOf(req), req.params.caseId, req.params.documentId));
  }

  static async retryDocument(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.retryDocument(clientWorkspaceOf(req), req.params.caseId, req.params.documentId));
  }

  static async overview(req: Request, res: Response) {
    res.status(200).json(await ClientCaseOverviewSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  static async generateOverview(req: Request, res: Response) {
    res.status(202).json(await ClientOverviewSvc.beginQueued(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async intake(req: Request, res: Response) {
    res.status(200).json(await ClientIntakeSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  /** The client's Case summary PDF, sent as the download itself (ClientCaseSummarySvc). */
  static async exportSummary(req: Request, res: Response) {
    const { lang } = validate<{ format: "pdf"; lang: "en" | "ko" }>(exportClientCaseSummarySchema, req.query);
    const { buffer, filename } = await ClientCaseSummarySvc.exportPdf(clientWorkspaceOf(req), req.user.userId, req.params.caseId, lang);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", contentDisposition(filename));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(buffer);
  }

  static async refreshIntake(req: Request, res: Response) {
    res.status(202).json(await ClientIntakeSvc.beginQueued(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async lawyerReadiness(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.lawyerReadiness(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async missingEvidence(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.missingEvidence(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async pricing(req: Request, res: Response) {
    res.status(200).json(await ClientBillingSvc.pricing(req.user.userId));
  }

  /** The old POST /payments/case and /payments/case/quote. Cases are free now (ADR 0019); a client
   * app still open from before gets a clear answer instead of a 404. */
  static async casePaymentGone(_req: Request, _res: Response) {
    throw new HttpError("Cases are free now. Refresh the page to create your case.", 410, "CASES_ARE_FREE");
  }

  static async quoteTopUp(req: Request, res: Response) {
    const { packId, promoCode } = validate(quoteClientTopUpSchema, req.body);
    res.status(200).json(await ClientBillingSvc.quoteTopUp(req.user.userId, packId, promoCode));
  }

  static async topUp(req: Request, res: Response) {
    const input = validate(topUpClientCaseSchema, req.body);
    res.status(201).json(await ClientCaseSvc.topUp(clientWorkspaceOf(req), req.user.userId, req.params.caseId, { ...input, origin: req.headers.origin }));
  }

  /** Where a payment stands; checks a pending Stripe payment with Stripe first. */
  static async paymentStatus(req: Request, res: Response) {
    res.status(200).json(await ClientBillingSvc.paymentStatus(req.user.userId, req.params.paymentId));
  }
}
