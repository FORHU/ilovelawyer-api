import { FeedbackRating, FeedbackSource } from "@prisma/client";
import FeedbackRepo, { ListFeedbackParams } from "../repositories/feedback.repository";
import OrganizationSvc from "./organization.service";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import { openField, sealField } from "../utils/field-crypto";
import { FEEDBACK_COMMENT_LABEL } from "../constants/feedback.constants";

export interface SubmitFeedbackInput {
  source: FeedbackSource;
  rating?: FeedbackRating;
  category?: string;
  comment?: string;
  organizationId?: string;
  caseId?: string;
  consultationId?: string;
  messageId?: string;
  panelId?: string;
  pagePath?: string;
  viewport?: string;
}

const USER_AGENT_MAX_CHARS = 300;

export default class FeedbackSvc {
  /** Stores one piece of feedback. The case, consultation and organization are worked out here from
   * what the caller can open, not taken on trust from the client: feedback is never filed against a
   * case, conversation or answer the sender can't see. A chat answer's conversation, case and org
   * come from the message itself. Stores ids and the sender's own words, never answer or pane text. */
  static async submit(userId: string, input: SubmitFeedbackInput, userAgent?: string) {
    let { organizationId, caseId, consultationId } = input;

    // A reply that has just finished streaming may not be saved yet, so a message id that isn't found
    // is dropped rather than refused: the feedback still lands, against the conversation the client named.
    let messageId: string | undefined;
    if (input.messageId) {
      const message = await FeedbackRepo.findMessage(input.messageId);
      if (message) {
        messageId = message.id;
        consultationId = message.consultationId;
      }
    }

    if (consultationId) {
      const consultation = await FeedbackRepo.findConsultation(consultationId);
      if (!consultation) throw new HttpError("Conversation not found", 404);
      if (consultation.userId !== userId) {
        // Someone else's conversation: only reachable through a case the sender can open.
        if (!consultation.caseId) throw new HttpError("Conversation not found", 404);
        await CaseAccess.loadAccessibleCase(consultation.caseId, userId);
      }
      caseId = consultation.caseId ?? caseId;
      organizationId = consultation.organizationId ?? organizationId;
    }

    if (caseId) {
      const record = await CaseAccess.loadAccessibleCase(caseId, userId);
      organizationId = record.organizationId ?? organizationId;
    } else if (organizationId) {
      // A client-supplied organization only stands if the sender belongs to it. Failing quietly:
      // a feedback form should never refuse over a stale workspace id.
      organizationId = await OrganizationSvc.requireMembership(organizationId, userId).then(
        () => organizationId,
        () => undefined,
      );
    }

    const row = await FeedbackRepo.create({
      userId,
      source: input.source,
      rating: input.rating ?? null,
      category: input.category ?? null,
      comment: input.comment ? sealField(input.comment, FEEDBACK_COMMENT_LABEL, true) : null,
      organizationId: organizationId ?? null,
      caseId: caseId ?? null,
      consultationId: consultationId ?? null,
      messageId: messageId ?? null,
      panelId: input.panelId ?? null,
      pagePath: input.pagePath ?? null,
      userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_CHARS) : null,
      viewport: input.viewport ?? null,
    });
    return { id: row.id, createdAt: row.createdAt };
  }

  /** For the admin list: the comment opened. null when it is sealed and cannot be opened (a key that
   * is no longer configured); the row is still listed. */
  static async list(params: ListFeedbackParams) {
    const { data, total, resolved } = await FeedbackRepo.list(params);
    return { data: data.map((row) => ({ ...row, comment: openField(row.comment, FEEDBACK_COMMENT_LABEL) })), total, resolved };
  }
}
