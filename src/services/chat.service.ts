import type { ConsultationStatus } from "@prisma/client";
import ChatRepo from "../repositories/chat.repository";
import { consultationDeletionDueAt } from "../constants/consultation-deletion.constants";
import AuthRepo from "../repositories/auth.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CaseSvc from "./case.service";
import CaseAccess from "../utils/case-access";
import DocumentChunkSvc from "./document-chunk.service";
import TranscriptionChunkSvc from "./transcription-chunk.service";
import { mapDocumentToDto } from "./document.service";
import { enrichRelatedCaseTitles } from "../utils/related-case-titles";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, GenerationCancelledError, RelatedCase, CaseDocumentGrounding, ChatWonderStage } from "../utils/chatWonder";
import TraceCollectorSvc, { TraceTurn } from "./trace-collector.service";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { extractTimeline, extractMindMap, stripStructuredBlocks, splitIntoTopics, MindMapItem, TimelineItem, AudioOverviewTurn, ReasoningExplanation, DecisionRecordsPayload, TraceStep } from "../utils/response-parser";
import { DocumentRef, redactDocumentIds, sanitizeDecisionRecords, decisionRecordsNeedSanitizing } from "../utils/document-references";
import DecisionRecordSvc from "./decision-record.service";
import GeneratedDocumentExportSvc from "./generated-document-export.service";
import CaseTimelineSvc from "./case-timeline.service";
import { documentBelongsToScope } from "../utils/case-document-scope";
import { getChatTitlePromptBuilder } from "../legal/prompt-registry";
import type { ChatTitleContext } from "../legal/shared/chat-title-context";
import { buildChatRetitlePrompt } from "../legal/shared/chat-retitle.prompt";
import { TenantCode } from "../types/tenant-code";
import { voicePairForCase } from "../utils/audio-overview-voices";
import type { MarkTiming } from "../utils/audio-overview-render";
import AudioOverviewQueue from "../queues/audio-overview.queue";
import { audioOverviewFilename } from "../utils/audio-overview-filename";
import { checkAudioOverviewTurns, isAudioOverviewJevEnabled } from "../utils/audio-overview-jev";
import CaseGraphPromotionQueue, { CaseGraphPromotionPayload } from "../queues/case-graph-promotion.queue";
import GroundingVerifierSvc from "./grounding-verifier.service";
import CitationRankSvc from "./citation-rank.service";
import { triageMessage, triageContextFor, notificationFor, resolveReplyLanguage, MessageTriage, ATTACHMENT_THRESHOLD } from "../utils/message-triage";
import NotificationSvc from "./notification.service";
import ParticipantRepo from "../repositories/participant.repository";
import ChatGenerationQueue, { ChatGenerationJob } from "../queues/chat-generation.queue";
import { getProxyFileUrl } from "../utils/s3";
import CaseMindMapSvc from "./case-mind-map.service";
import DamageClaimSvc, { type CaseDamagesChatContext } from "./damage-claim.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import DecisionRecordRepo from "../repositories/decision-record.repository";
import { emitToUser } from "../lib/socket";
import { TITLE_CACHE_TTL, RESPONSE_CACHE_TTL, TITLE_MAX_CHARS, CHAT_WONDER_SESSION_TTL_S, ATTACHMENT_ONLY_PROMPT, UNCLEAR_TITLE_SENTINEL, PROVISIONAL_UNCLEAR_TITLE, KEEP_TITLE_SENTINEL, SMALL_TALK_TITLE_SENTINEL, PROVISIONAL_GREETING_TITLE } from "../constants";
import { chatWonderSessionKey, titleCacheKey, responseCacheKey, groundingCacheKey } from "../utils/chat.utils";
import { resolveRelatedCaseLibraryLinks, rewriteLegalCitationLinks } from "../utils/legal-citation-link-rewrite";
import SecurityAuditSvc from "./security-audit.service";

/** How a running chat turn is stopped — see ChatSvc.processChatGenerationJob/cancelChatGeneration. */
interface GenerationControl {
  abort: AbortController;
  /** Raw text streamed so far, live — read by a Stop on the same instance so the saved partial
   * reply matches what the user saw (an other-instance Stop falls back to the 1s checkpoint). */
  getPartial: () => string;
}

/** How often a running job checks whether a Stop landed on another instance. */
const CANCEL_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded exponential backoff for the request-path canonical-persistence retry — 2s, 4s, 8s.
// Long enough to ride out a transient RDS blip, bounded enough not to hang the HTTP request
// indefinitely if the DB is genuinely down (worst case adds ~14s before the request fails).
/** Link target chat-wonder has the model write for a generated document's inline download link. */
const DOWNLOAD_PLACEHOLDER = "(#download)";

// Kept under AWS Transcribe's own 12-minute ceiling (transcription.service.ts) so a slow-but-healthy
// video usually finishes first, while a hung one still lets the turn proceed eventually.
const ATTACHMENT_READY_MAX_WAIT_MS = 10 * 60_000;
const ATTACHMENT_READY_POLL_MS = 3_000;
const PERSIST_RETRIES = 3;
const PERSIST_RETRY_BASE_MS = 2_000;

/** Everything ChatSvc.persistAssistantTurn needs to write the canonical, durable record of a
 * completed AI turn — captured in memory the instant the stream (or cache replay) finishes.
 * Unlike the old queue-carried payload of the same shape, this one is only ever passed
 * in-process (see sendMessage), never serialized over SQS — persistAssistantTurn now runs
 * synchronously in the request path, before the HTTP response ends. */
export interface AssistantTurnPayload {
  consultationId: string;
  /** The user Message this reply answers — assistant rows hang off it as parentMessageId. */
  parentMessageId: string;
  effectiveCaseId: string | null;
  userId: string;
  tenantCode: TenantCode;
  /** Raw accumulated reply text — persistAssistantTurn still needs the un-stripped form for
   * stripStructuredBlocks / splitIntoTopics / the extractTimeline+extractMindMap fallback. */
  fullResponse: string;
  relatedCases: RelatedCase[];
  mindMap?: MindMapItem;
  timeline?: TimelineItem[];
  audioOverview?: AudioOverviewTurn[];
  reasoning?: ReasoningExplanation;
  decisions?: DecisionRecordsPayload;
  draftedDocument?: { content: string; format: "docx" | "pdf"; documentType?: string; documentName?: string };
  researchSteps?: TraceStep[];
}

export default class ChatSvc {
  /** Jobs currently running on THIS instance, so a Stop that lands here can abort them at once. */
  private static activeGenerations = new Map<string, GenerationControl>();

  static async createConsultation(organizationId: string, userId: string, title?: string, caseId?: string) {
    if (caseId) {
      // Throws 404 if the case doesn't exist or isn't in this organization
      await CaseSvc.getById(caseId, organizationId);
      // ...or if this user can't open it — a Case's Consultations belong to the people on the Case.
      await CaseAccess.loadAccessibleCase(caseId, userId);
    }
    return ChatRepo.createConsultation(organizationId, userId, title, caseId);
  }

  /** With a caseId, every Consultation on that Case — shared with everyone who can open the Case,
   * not just the ones this user started (see CONTEXT.md's Consultation entry). */
  static async listConsultations(organizationId: string, userId: string, caseId?: string, status: Exclude<ConsultationStatus, "FOR_DELETION"> = "ACTIVE") {
    if (caseId) await CaseAccess.loadAccessibleCase(caseId, userId);
    return ChatRepo.listConsultations(organizationId, caseId, status);
  }

  /**
   * Delivers whatever notificationFor (message-triage.ts) decided a triage result warrants, as a
   * CASE_UPDATE to everyone on the consultation EXCEPT the sender — they already know. Recipients:
   * the consultation owner plus every accepted participant, deduped. This method owns delivery
   * only; the policy (which triage results notify, and the wording) lives next to the labels so it
   * can grow without touching this. Called fire-and-forget from processChatGenerationJob.
   */
  static async notifyTriagedMessage(
    consultation: { id: string; userId: string; organizationId: string; title: string | null; caseId: string | null },
    senderUserId: string,
    userInput: string,
    triage: MessageTriage,
    effectiveCaseId?: string,
  ): Promise<void> {
    const decision = notificationFor(triage, consultation.title);
    if (!decision) return;

    const participants = await ParticipantRepo.list(consultation.id);
    const recipients = new Set<string>([consultation.userId, ...participants.map((p) => p.userId)]);
    recipients.delete(senderUserId);
    if (recipients.size === 0) return;

    const caseId = consultation.caseId ?? effectiveCaseId;
    const link = caseId ? `/homepage/terminal/${caseId}?c=${consultation.id}` : `/homepage/terminal?c=${consultation.id}`;
    const excerpt = userInput.trim().replace(/\s+/g, " ");
    const message = excerpt.length > 140 ? `${excerpt.slice(0, 137)}…` : excerpt;

    await Promise.all(
      Array.from(recipients).map((recipientId) =>
        NotificationSvc.create({
          userId: recipientId,
          organizationId: consultation.organizationId,
          type: "CASE_UPDATE",
          title: decision.title,
          message,
          link,
        }),
      ),
    );
    logger.info("Jev triage: notification sent", {
      feature: "message-triage",
      consultationId: consultation.id,
      recipients: recipients.size,
      reason: decision.reason,
      intent: triage.intent,
      probability: triage.probability,
    });
  }

  static async renameConsultation(organizationId: string, userId: string, consultationId: string, title: string) {
    await this.assertConsultationAccess(organizationId, userId, consultationId);
    return ChatRepo.updateConsultation(consultationId, title);
  }

  static async assertConsultationOwned(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    return consultation;
  }

  /** assertConsultationOwned plus, for a case-linked Consultation, that this user may use it: its
   * creator, an invited participant, or anyone who can open the Case. A standalone (case-less)
   * Consultation keeps the organization-only check it always had. 404 either way, so a
   * Consultation on a Case the user can't see is indistinguishable from one that doesn't exist. */
  static async assertConsultationAccess(organizationId: string, userId: string, consultationId: string) {
    const consultation = await this.assertConsultationOwned(organizationId, consultationId);
    await this.assertCaseLinkedAccess(consultation, userId);
    return consultation;
  }

  private static async assertCaseLinkedAccess(
    consultation: { id: string; userId: string; caseId: string | null },
    userId: string,
  ) {
    if (!consultation.caseId || consultation.userId === userId) return;
    if (await ParticipantRepo.exists(consultation.id, userId)) return;
    try {
      await CaseAccess.loadAccessibleCase(consultation.caseId, userId);
    } catch {
      throw new HttpError("Consultation not found", 404);
    }
  }

  /** The creator, or — for a case-linked Consultation — anyone who can edit the Case. Everyone on
   * the Case can see a colleague's Consultation, but only these people can archive, restore or
   * delete it. */
  private static async assertCanRemove(organizationId: string, userId: string, consultationId: string) {
    const consultation = await this.assertConsultationAccess(organizationId, userId, consultationId);
    if (consultation.caseId && consultation.userId !== userId) {
      try {
        await CaseAccess.assertCanEdit(consultation.caseId, userId);
      } catch {
        throw new HttpError("Only its creator or a case editor can archive or delete this consultation", 403);
      }
    }
    return consultation;
  }

  /** The soft delete: hides the Consultation from its lists (see ConsultationStatus) with every
   * message, file and Topic kept, so unarchive brings it back exactly as it was. Idempotent. */
  static async archiveConsultation(organizationId: string, userId: string, consultationId: string) {
    const consultation = await this.assertCanRemove(organizationId, userId, consultationId);
    // Re-archiving would silently cancel the scheduled deletion; restoring is how that's done.
    if (consultation.status === "FOR_DELETION") {
      throw new HttpError("This consultation is scheduled for deletion — restore it instead", 409);
    }
    // A reply still generating would land in a consultation nobody can see or answer. The app
    // disables Archive for the replies it knows about; this covers the rest (another tab, a
    // colleague's turn).
    if (await ChatRepo.hasPendingTurn(consultationId)) {
      throw new HttpError("A reply is still generating — archive it once it finishes", 409, "REPLY_GENERATING");
    }
    return ChatRepo.setConsultationStatus(consultationId, "ARCHIVED");
  }

  static async unarchiveConsultation(organizationId: string, userId: string, consultationId: string) {
    await this.assertCanRemove(organizationId, userId, consultationId);
    return ChatRepo.setConsultationStatus(consultationId, "ACTIVE");
  }

  /** Schedules permanent deletion by moving ARCHIVED → FOR_DELETION — only from the archive, so a
   * single click can never destroy a live thread. It stays restorable (restoring cancels this) for
   * CONSULTATION_DELETION_GRACE_PERIOD_DAYS; then ConsultationDeletionQueue removes the messages
   * and everything hanging off them, plus files uploaded into this chat alone, whose S3 objects
   * are flagged FOR_DELETION (see ChatRepo.deleteConsultationPermanently). Files uploaded to the
   * Case from inside this chat stay with the Case. */
  static async deleteConsultation(organizationId: string, userId: string, consultationId: string) {
    const consultation = await this.assertCanRemove(organizationId, userId, consultationId);
    if (consultation.status === "FOR_DELETION") {
      throw new HttpError("Deletion is already scheduled for this consultation", 409);
    }
    if (consultation.status !== "ARCHIVED") {
      throw new HttpError("Archive this consultation before deleting it permanently", 409);
    }
    const updated = await ChatRepo.requestConsultationDeletion(consultationId, new Date());
    const deletionScheduledFor = consultationDeletionDueAt(updated.deletionRequestedAt!);
    // Recorded when the user deletes it; ConsultationDeletionQueue purges it after the grace period.
    await SecurityAuditSvc.record({
      action: "consultation.deleted",
      actorId: userId,
      organizationId,
      targetType: "consultation",
      targetId: consultationId,
      caseId: consultation.caseId ?? null,
      payload: { deletionScheduledFor: deletionScheduledFor.toISOString() },
    });
    return { deletionScheduledFor };
  }

  static async listMessages(organizationId: string, userId: string, consultationId: string) {
    const consultation = await this.assertConsultationAccess(organizationId, userId, consultationId);

    const messages = await ChatRepo.listMessagesByConsultation(consultationId);

    // File ids must never reach a user (see utils/document-references.ts). New turns are cleaned
    // before they are saved; this covers messages saved before that, and heals them once.
    const looksLeaky = (m: (typeof messages)[number]) =>
      Boolean(m.decisionRecords && decisionRecordsNeedSanitizing({ records: m.decisionRecords.records })) ||
      (m.role === "assistant" && /\(\s*id:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m.content));
    const scopeDocs = messages.some(looksLeaky)
      ? await ChatSvc.scopeDocumentRefs(organizationId, consultationId, consultation.caseId)
      : [];

    return Promise.all(
      messages.map(async ({ generatedDocument, decisionRecords, ...m }) => {
        let cleanedDecisionRecords = decisionRecords;
        if (decisionRecords && decisionRecordsNeedSanitizing({ records: decisionRecords.records })) {
          const cleaned = await ChatSvc.sanitizeDecisionPayload(
            { records: decisionRecords.records as unknown as DecisionRecordsPayload["records"] },
            { organizationId, consultationId, caseId: consultation.caseId },
            scopeDocs,
          );
          cleanedDecisionRecords = { ...decisionRecords, records: cleaned.records as unknown as typeof decisionRecords.records };
          // Best-effort: later reads (and anything else reading the row) get the clean form for free.
          ChatRepo.updateDecisionRecords(m.id, cleaned).catch((err) =>
            logger.warn("Chat: could not persist sanitized decision records", { err, messageId: m.id }),
          );
        }
        if (m.role === "assistant" && scopeDocs.length) m.content = redactDocumentIds(m.content, scopeDocs);
        const file = generatedDocument?.file;
        // The real URL is filled in here, at read time, rather than stored in the message: the
        // presigned URL expires, and the stored content is also what gets replayed to chat-wonder
        // as history — it shouldn't carry a dead URL. chat-wonder has the model write the link
        // inline as `[affidavit of loss](#download)`; if it didn't, a "Download …" line is appended.
        let content = m.content;
        if (file?.s3Key) {
          const url = getProxyFileUrl(file.s3Key, {
            filename: file.filename ?? undefined,
            audit: { kind: "generated_document", id: file.id, caseId: consultation.caseId },
          });
          content = content.includes(DOWNLOAD_PLACEHOLDER)
            ? content.split(DOWNLOAD_PLACEHOLDER).join(`(${url})`)
            : `${content}

[Download ${generatedDocument?.documentName || "document"} (${file.filename?.split(".").pop() ?? "file"})](${url})`;
        }
        return {
          ...m,
          content,
          decisionRecords: cleanedDecisionRecords,
          documents: await Promise.all(m.documents.map(mapDocumentToDto)),
        };
      }),
    );
  }

  /** (id, name) of the documents in scope for a consultation/case, for turning file ids into
   * names. Never throws: with no list, ids are still replaced by a generic label, never shown. */
  static async scopeDocumentRefs(
    organizationId: string | null | undefined,
    consultationId: string,
    caseId?: string | null,
  ): Promise<DocumentRef[]> {
    if (!organizationId) return [];
    try {
      const rows = await DocumentRepo.listRefsForScope(organizationId, { consultationId, caseId });
      return rows.map((d) => ({ id: d.id, name: d.name }));
    } catch (err) {
      logger.warn("Chat: could not load scope documents for id redaction", { err, consultationId });
      return [];
    }
  }

  /**
   * Replaces file ids in a set of Decision Records with file names, and re-checks each quote
   * against its document's own text once that document is known (chat-wonder could not resolve
   * a label that was an id, so it marked the evidence unverified). Only ever upgrades `verified`.
   * `docs` may be passed in when the caller already loaded them.
   */
  static async sanitizeDecisionPayload(
    payload: DecisionRecordsPayload,
    scope: { organizationId: string | null | undefined; consultationId: string; caseId?: string | null },
    docs?: DocumentRef[],
  ): Promise<DecisionRecordsPayload> {
    if (!decisionRecordsNeedSanitizing(payload)) return payload;
    const refs = docs ?? (await ChatSvc.scopeDocumentRefs(scope.organizationId, scope.consultationId, scope.caseId));

    let texts: Map<string, string> | undefined;
    const inScope = new Set(refs.map((d) => d.id.toLowerCase()));
    const wanted = new Set<string>();
    for (const rec of payload.records) {
      for (const e of [...rec.evidenceFor, ...rec.evidenceAgainst]) {
        if (!e.quote || e.verified) continue;
        const id = (e.docId ?? (inScope.has(e.doc.trim().toLowerCase()) ? e.doc.trim() : null))?.toLowerCase();
        if (id && inScope.has(id)) wanted.add(id);
      }
    }
    if (wanted.size) {
      try {
        const raw = await DocumentChunkRepo.findFullTextsByDocuments([...wanted]);
        texts = new Map([...raw].map(([id, text]) => [id.toLowerCase(), text]));
      } catch (err) {
        logger.warn("Chat: could not load document text to re-check decision quotes", { err });
      }
    }
    return sanitizeDecisionRecords(payload, refs, { texts });
  }

  static async deleteMessage(organizationId: string, consultationId: string, messageId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    const message = await ChatRepo.findMessageById(messageId);
    if (!message || message.consultationId !== consultationId) {
      throw new HttpError("Message not found", 404);
    }
    const deleted = await ChatRepo.deleteMessage(messageId);
    await SecurityAuditSvc.record({
      action: "consultation.message_deleted",
      organizationId,
      targetType: "message",
      targetId: messageId,
      caseId: consultation.caseId ?? null,
      payload: { consultationId, role: message.role },
    });
    return deleted;
  }

  /**
   * The ONLY thing the HTTP request now does for a chat turn: validate/authorize, create the
   * user Message row (PENDING — this row's id doubles as the job's id, see
   * ChatGenerationJob.jobId's doc comment for why there's no separate job table), and hand the
   * rest off to ChatGenerationQueue. Returns immediately — the browser is never made to wait
   * for RAG/cache/AI generation/persistence, and the AI job's fate no longer depends on this
   * HTTP connection staying open (see ChatSvc.processChatGenerationJob, which is what a worker
   * actually runs, decoupled from this request entirely).
   *
   * effectiveCaseId and the Chat Wonder session are resolved HERE, not in the worker: both are
   * cheap (an ownership check / a redis-cached lookup, not a Chat Wonder network call in the
   * common case) and both matter for the response — a bad/foreign caseId 404s immediately
   * instead of only surfacing after a round trip through SQS, and the effective session id is
   * returned to the client right away instead of arriving later over the socket.
   */
  static async enqueueChatGeneration(
    organizationId: string,
    tenantCode: TenantCode,
    userId: string,
    consultationId: string,
    requestedSessionId: string,
    userInput: string,
    documentContext?: string,
    caseDocumentId?: string,
    caseId?: string,
    documentIds?: string[],
  ): Promise<{ messageId: string; sessionId: string; replyStatus: "PENDING" }> {
    const t0 = Date.now();
    logger.info("Chat: enqueueChatGeneration started", { consultationId });

    const consultation = await ChatRepo.findConsultationWithCase(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    await ChatSvc.assertCaseLinkedAccess(consultation, userId);
    // Archived (or on its way to deletion) means set aside: nothing new lands in it until it's restored.
    if (consultation.status !== "ACTIVE") {
      throw new HttpError("This consultation is archived — restore it to continue", 409);
    }

    // Reject a second concurrent turn outright rather than silently enqueueing it onto the same
    // Chat Wonder session as the one already running (see hasPendingTurn's doc comment) — every
    // known client caller (the composer, Mind Map, Audio Overview) already checks its own busy
    // flag first, but this is what actually closes the gap for a caller that doesn't.
    if (await ChatRepo.hasPendingTurn(consultationId)) {
      throw new HttpError("A reply is already generating for this consultation", 409);
    }

    // Prefer consultation.caseId; allow per-message caseId for case-portfolio chats
    // whose consultation was created without a case link.
    let effectiveCaseId = consultation.caseId ?? undefined;
    if (!effectiveCaseId && caseId) {
      await CaseSvc.getById(caseId, organizationId); // ownership check
      effectiveCaseId = caseId;
    }

    // One Chat Wonder session per consultation. The client caches a single session_id for
    // the whole app; reusing it across cases leaks prior-case document text via session history.
    const sessionId = await ChatSvc.resolveChatWonderSession(consultationId);
    logger.info("Chat: session resolved", {
      consultationId,
      sessionId,
      rotated: sessionId !== requestedSessionId,
      elapsedMs: Date.now() - t0,
    });

    const userMessage = await ChatRepo.createMessage(
      consultationId,
      "user",
      userInput,
      userId,
      undefined,
      undefined,
      undefined,
      undefined,
      "PENDING",
    );
    logger.info("Chat: user message created", { consultationId, messageId: userMessage.id, elapsedMs: Date.now() - t0 });

    if (documentIds?.length) {
      await DocumentRepo.linkToMessage(documentIds, userMessage.id, organizationId, consultationId);
    }

    ChatGenerationQueue.enqueue({
      jobId: userMessage.id,
      organizationId,
      tenantCode,
      userId,
      consultationId,
      sessionId,
      userInput,
      documentContext,
      caseDocumentId,
      effectiveCaseId: effectiveCaseId ?? null,
      enqueuedAt: Date.now(),
    });

    logger.info("Chat: enqueueChatGeneration completed — job handed to worker", {
      consultationId,
      messageId: userMessage.id,
      elapsedMs: Date.now() - t0,
    });

    return { messageId: userMessage.id, sessionId, replyStatus: "PENDING" };
  }

  /**
   * Runs a chat turn's ENTIRE AI generation lifecycle — RAG, cache check, AI streaming,
   * checkpointing, canonical persistence, background work enqueue — OWNED BY THE WORKER
   * (ChatGenerationQueue), not by whatever HTTP request originally created the job. This is
   * the queue-driven replacement for the old synchronous-in-request ChatSvc.sendMessage: the
   * request that created `job` may have long since returned (or the browser that sent it may
   * have refreshed or closed entirely) by the time this runs, and that must not matter — the
   * job runs to completion regardless, live chunks go out over the socket on a best-effort
   * basis (emitToUser is a no-op if nobody's connected), and the canonical assistant message
   * still gets durably persisted either way (see persistAssistantTurnWithRetry below).
   */
  static async processChatGenerationJob(job: ChatGenerationJob): Promise<void> {
    // Stop support: ChatSvc.cancelChatGeneration flips replyStatus to CANCELLED (the durable,
    // cross-instance signal — this job may run on a different instance than the one that got
    // the cancel request) and, when it happens to be on this same instance, aborts `abort`
    // directly via this registry. The poll below covers the cross-instance case; it is not
    // needed for correctness of the DB state, only to stop generating (and billing) promptly.
    const control: GenerationControl = { abort: new AbortController(), getPartial: () => "" };
    ChatSvc.activeGenerations.set(job.jobId, control);
    const cancelPoll = setInterval(() => {
      ChatRepo.findReplyState(job.jobId)
        .then((state) => {
          if (state?.replyStatus === "CANCELLED") control.abort.abort();
        })
        .catch(() => {});
    }, CANCEL_POLL_INTERVAL_MS);
    try {
      await ChatSvc.runChatGenerationJob(job, control);
    } finally {
      clearInterval(cancelPoll);
      ChatSvc.activeGenerations.delete(job.jobId);
    }
  }

  /**
   * Stops an in-flight chat turn (the Stop button). Idempotent: cancelling a turn that already
   * finished, failed or was cancelled just reports its current replyStatus.
   *
   * Owns everything the user-visible result of a stop needs, so the client gets a deterministic
   * answer from this one call instead of waiting on the worker: it flips replyStatus PENDING ->
   * CANCELLED (one conditional write — races the worker's own DONE/FAILED with a single winner),
   * saves whatever reply text had streamed so far as an ordinary assistant message (no topic
   * split, structured extras or related cases — those need a finished answer), aborts the
   * worker's Chat Wonder socket if the job runs on this instance, and emits chat:cancelled. A job
   * on another instance notices the CANCELLED status within CANCEL_POLL_INTERVAL_MS and stops;
   * its partial text then comes from the ~1s-old checkpoint rather than the live buffer.
   */
  static async cancelChatGeneration(
    organizationId: string,
    requesterUserId: string,
    consultationId: string,
    messageId: string,
  ): Promise<{ messageId: string; replyStatus: string | null; assistantMessageId?: string }> {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    const message = await ChatRepo.findReplyState(messageId);
    if (!message || message.consultationId !== consultationId || message.role !== "user") {
      throw new HttpError("Message not found", 404);
    }

    const cancelled = await ChatRepo.markReplyCancelled(messageId, consultationId);
    if (!cancelled) {
      const current = await ChatRepo.findReplyState(messageId);
      return { messageId, replyStatus: current?.replyStatus ?? null };
    }

    const running = ChatSvc.activeGenerations.get(messageId);
    const partialRaw = running ? running.getPartial() : (message.pendingReplyContent ?? "");
    running?.abort.abort();

    const partial = stripStructuredBlocks(partialRaw);
    let assistantMessageId: string | undefined;
    if (partial) {
      const existing = await ChatRepo.findAssistantReplyByParent(messageId);
      assistantMessageId =
        existing?.id ?? (await ChatRepo.createMessage(consultationId, "assistant", partial, undefined, messageId)).id;
    }

    logger.info("Chat generation: cancelled by user", {
      consultationId,
      messageId,
      ranOnThisInstance: Boolean(running),
      partialChars: partial.length,
    });
    for (const userId of new Set([message.userId, requesterUserId].filter((id): id is string => Boolean(id)))) {
      try {
        emitToUser(userId, "chat:cancelled", { consultationId, messageId, assistantMessageId });
      } catch (err) {
        logger.warn("Chat generation: emitToUser(chat:cancelled) failed", { err, messageId });
      }
    }
    return { messageId, replyStatus: "CANCELLED", assistantMessageId };
  }

  private static async runChatGenerationJob(job: ChatGenerationJob, control: GenerationControl): Promise<void> {
    const t0 = Date.now();
    const { signal } = control.abort;
    logger.info("Chat generation: processing started", { jobId: job.jobId, consultationId: job.consultationId });

    const { jobId: parentMessageId, organizationId, tenantCode, userId, consultationId, sessionId, caseDocumentId, documentContext } = job;
    const effectiveCaseId = job.effectiveCaseId ?? undefined;

    const consultation = await ChatRepo.findConsultationWithCase(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      // The consultation was deleted between enqueue and this job running — nothing left to
      // reply into. Not retryable (see ChatGenerationQueue's doc comment on why it always
      // acks): re-running the same job against a gone consultation would never succeed.
      logger.warn("Chat generation: consultation no longer exists, dropping job", {
        jobId: parentMessageId,
        consultationId,
      });
      return;
    }
    const userInput = job.userInput;

    // Stopped while still queued (or waiting on SQS) — nothing to generate, and nothing to emit:
    // ChatSvc.cancelChatGeneration already told the client.
    const initialState = await ChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (initialState?.replyStatus === "CANCELLED") {
      logger.info("Chat generation: cancelled before start, skipping", { jobId: parentMessageId, consultationId });
      return;
    }

    // The documents in scope for this turn, as (id, name): every id that reaches a user (live
    // chunks, the saved answer, Decision Records) is turned into a name first. One light query.
    const scopeDocs = await ChatSvc.scopeDocumentRefs(organizationId, consultationId, effectiveCaseId ?? consultation.caseId);

    // emitToUser is documented as never throwing (lib/socket.ts), but this is called
    // synchronously from inside streamChatWonderMessage's ws.onmessage handler on every
    // chunk — an uncaught throw there would propagate out of that handler and could abort
    // generation (or worse) over a live-push failure that has nothing to do with whether the
    // turn itself is succeeding. A disconnected/broken socket layer must never take an AI job
    // down with it (see the class-level "browser failure" invariant this queue is built on).
    const emitEvent = (event: string, payload: Record<string, unknown>) => {
      try {
        emitToUser(userId, event, { consultationId, messageId: parentMessageId, ...payload });
      } catch (err) {
        logger.warn("Chat generation: emitToUser failed, continuing without it", { err, event, jobId: parentMessageId });
      }
    };

    // Fired once the job is confirmed real (consultation still exists) and about to start
    // actual work — lets a connected client flip straight to "generating" instead of waiting
    // for the first token. Purely a live-UX signal: nothing downstream depends on it arriving.
    emitEvent("chat:started", {});
    logger.info("Chat generation: chat:started emitted", { jobId: parentMessageId, consultationId });

    // Attachments sent with this message are still PENDING while they're extracted/transcribed
    // (audio/video especially), and grounding below only sees READY documents — replying now would
    // tell the user no files are attached. Hold the reply (the client already shows "generating")
    // until they settle, capped so a stuck extraction can't hang the turn forever.
    const attachmentWaitStartedAt = Date.now();
    try {
      while (
        Date.now() - attachmentWaitStartedAt < ATTACHMENT_READY_MAX_WAIT_MS &&
        (await DocumentRepo.countPendingByMessage(parentMessageId)) > 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, ATTACHMENT_READY_POLL_MS));
      }
    } catch (err) {
      logger.warn("Chat generation: attachment wait failed, continuing", { err, jobId: parentMessageId });
    }
    if (Date.now() - attachmentWaitStartedAt > ATTACHMENT_READY_POLL_MS) {
      logger.info("Chat generation: waited for attachments to finish indexing", {
        jobId: parentMessageId,
        waitedMs: Date.now() - attachmentWaitStartedAt,
      });
    }

    // Untitled or only provisionally titled -> generate one. AI-titled -> check it still fits
    // (refreshTitle). Renamed by the user -> leave it alone. A null source on a titled row is
    // treated as AI-titled (pre-titleSource rows are backfilled AUTO; this is belt and braces).
    const needsTitle = consultation.title === null || consultation.titleSource === "PROVISIONAL";
    const canRefreshTitle = !needsTitle && consultation.titleSource !== "USER";

    // content stays a stored empty string for a file-only send (see ADR) — everything the AI
    // and title generation actually see substitutes in a fixed stand-in instead.
    const effectiveUserInput = userInput.trim() ? userInput : ATTACHMENT_ONLY_PROMPT;

    // File names give the title something to go on when the message itself is vague ("what are
    // these documents?") — often the only real signal of what the consultation is about.
    const attachmentNames = needsTitle || canRefreshTitle
      ? await DocumentRepo.listNamesByMessage(parentMessageId).catch(() => [] as string[])
      : [];

    if (canRefreshTitle && consultation.title && (isSubstantive(userInput) || attachmentNames.length > 0)) {
      void ChatSvc.refreshTitle({ consultationId, tenantCode, userId, currentTitle: consultation.title, attachmentNames });
    }

    // Pass 1 runs alongside the reply (usually done in 1-2s). Its outcome is kept so the
    // post-reply pass (titleAfterReply, below) can tell whether it still needs to run.
    let titlePass: Promise<TitleOutcome> = Promise.resolve("saved");
    if (needsTitle) {
      const titleStartedAt = Date.now();
      titlePass = ChatSvc.generateAndSaveTitle(consultationId, effectiveUserInput, tenantCode, userId, {
        attachmentNames,
      }).catch((err) => {
        logger.error("Chat title: generation failed (non-fatal — reply unaffected, retried after the reply)", {
          consultationId,
          tenantCode,
          err,
          elapsedMs: Date.now() - titleStartedAt,
        });
        return "failed" as const;
      });
    }

    // Re-derived from the live Case row on every message (not cached on the consultation),
    // so edits to the Case's fields are picked up immediately rather than going stale.
    // consultation.case covers the overwhelmingly common path (the consultation itself is
    // case-linked); the explicit lookup only runs for a case-portfolio chat whose per-message
    // caseId points at a case the consultation itself isn't linked to (see
    // enqueueChatGeneration's effectiveCaseId resolution, which already ownership-checked it).
    let caseRecord = consultation.case;
    if (!caseRecord && effectiveCaseId) {
      caseRecord = await CaseSvc.getById(effectiveCaseId, organizationId);
    }
    const caseContext = caseRecord ? CaseSvc.formatForAiContext(caseRecord) : "";
    // The lawyer's hand edits to the case's strategy map (added/reworded/removed points), so the
    // answer reflects their current view of the case. Empty unless they've edited it since its
    // last build; best-effort — a failed read just leaves it out of this turn.
    const mindMapChangesContext = caseRecord
      ? await CaseMindMapSvc.lawyerChangesContext(caseRecord.id).catch((err) => {
          logger.warn("Chat: case mind map changes unavailable, sending the turn without them", {
            err,
            consultationId,
            caseId: caseRecord?.id,
          });
          return "";
        })
      : "";

    // Grounding priority:
    // 1. Explicit caseDocumentId on this message (single-doc ranking) — only if it belongs
    //    to this consultation or case. A client-supplied id from another case must not rank.
    // 2. READY docs attached to this consultation (consultation-specific data source)
    // 3. Case id (consultation or message body) → rank READY docs under that case
    let grounding: CaseDocumentGrounding | undefined;
    const scopedDocumentId = await ChatSvc.scopedCaseDocumentId(
      caseDocumentId,
      organizationId,
      userId,
      consultationId,
      effectiveCaseId,
    );
    // Rank against the same text the model sees — a file-only send stores "" on the
    // message but substitutes ATTACHMENT_ONLY_PROMPT for the prompt. Embedding that empty
    // string produced junk neighbors; this keeps retrieval aligned with the turn.
    const rankingQuery = effectiveUserInput;
    if (scopedDocumentId) {
      grounding = await DocumentChunkSvc.relevantChunksForDocument(scopedDocumentId, rankingQuery);
      if (!grounding.caseDocumentIds.length) grounding = undefined;
    } else {
      const consultationDocs = await DocumentChunkSvc.relevantChunksForConsultation(
        consultationId,
        rankingQuery,
      );
      if (consultationDocs.caseDocumentIds.length) {
        grounding = consultationDocs;
      } else if (effectiveCaseId) {
        grounding = await DocumentChunkSvc.relevantChunksForCase(effectiveCaseId, rankingQuery);
        if (!grounding.caseDocumentIds.length) grounding = undefined;
      }
    }

    // Inline ranked chunk text into document_context. Chat-wonder also receives case_document_ids
    // for its callback fetch, but that often fails in local/staging (ILOVELAWYER_API_BASE points
    // at production with a mismatched API key) — inlining keeps analysis working either way.
    const omitEmbeddingRanking = process.env.OMIT_EMBEDDING_RANKING === "true";
    if (omitEmbeddingRanking) {
      logger.info("OMIT_EMBEDDING_RANKING: sending document ids only, no ranked chunk ids");
    }
    const groundingContext =
      omitEmbeddingRanking
        ? ""
        : grounding
          ? await DocumentChunkSvc.formatGroundingContext(grounding, 12_000, {
              caseId: effectiveCaseId,
              consultationId,
            })
          : "";

    // Transcript grounding (ADR 0013): a parallel, independent lookup — never merged/ranked
    // together with Case Document grounding above. Same consultation → case priority shape, but
    // no per-message single-transcript equivalent to caseDocumentId (nothing analogous is sent).
    // Not part of `grounding`/CaseDocumentGrounding — chat-wonder's callback fetch only knows
    // about Documents, so transcript content is inlined into resolvedContext text only.
    const consultationTranscripts = await TranscriptionChunkSvc.relevantChunksForConsultation(
      consultationId,
      rankingQuery,
    );
    let transcriptGrounding = consultationTranscripts.transcriptionIds.length
      ? consultationTranscripts
      : effectiveCaseId
        ? await TranscriptionChunkSvc.relevantChunksForCase(effectiveCaseId, rankingQuery)
        : undefined;
    if (transcriptGrounding && !transcriptGrounding.transcriptionIds.length) transcriptGrounding = undefined;
    const transcriptContext = transcriptGrounding
      ? await TranscriptionChunkSvc.formatGroundingContext(transcriptGrounding)
      : "";

    // Awaited (unlike a purely observational log-only call) because its result feeds
    // resolvedContext below — chat-wonder needs it before generation starts, not after.
    // triageMessage never rejects and returns null when USE_JEV_MESSAGE_TRIAGE is unset, so
    // this is a no-op (empty string, no added latency) whenever the flag is off. One Jev call
    // answers both questions — urgency and intent (what the user is asking for: advice, a
    // document, a pleading, document analysis, research, paralegal work).
    const triage = await triageMessage(userInput);
    // "Is anything actually attached?" for the missing-attachment guard: documents sent with this
    // message, ranked case/consultation chunks, pasted document_context, or transcript chunks all
    // count. Only looked up when Jev says the message depends on a document, so the routine path
    // pays nothing.
    const hasAttachedMaterial =
      !triage || triage.refersToAttachment < ATTACHMENT_THRESHOLD
        ? true
        : Boolean(grounding) ||
          Boolean(documentContext) ||
          Boolean(transcriptGrounding) ||
          (await DocumentRepo.countForMessage(parentMessageId).catch(() => 0)) > 0;
    const triageContext = triageContextFor(triage, { hasAttachedMaterial });
    // The locale chat-wonder must answer in. Undefined when triage didn't run, which leaves
    // chat-wonder on its own langid path — see resolveReplyLanguage for why that path is the
    // problem this replaces. The sender's own preferredLanguage is the tie-breaker when Jev is
    // unsure, so an uncertain read never silently forces English on a non-English speaker; it is
    // only looked up on turns that were actually triaged.
    const senderPreferredLanguage = triage
      ? await AuthRepo.findPreferredLanguage(userId).catch(() => null)
      : undefined;
    const replyLanguage = resolveReplyLanguage(triage, senderPreferredLanguage);
    logger.info("Jev chat context injection", {
      feature: "message-triage",
      consultationId,
      messageId: parentMessageId,
      urgent: triage?.urgent ?? false,
      probability: triage?.probability ?? null,
      intent: triage?.intent ?? null,
      intentConfidence: triage?.intentConfidence ?? null,
      refersToAttachment: triage?.refersToAttachment ?? null,
      replyLanguage: replyLanguage ?? null,
      replyLanguageRaw: triage?.replyLanguage ?? null,
      replyLanguageConfidence: triage?.replyLanguageConfidence ?? null,
      hasAttachedMaterial,
      missingAttachment: Boolean(triage) && !hasAttachedMaterial,
      injected: Boolean(triageContext),
      injectedChars: triageContext.length,
    });
    if (triage) {
      // Everything below is a side channel for the triage signal — none of it may affect
      // whether this turn generates. Persistence is awaited (it's one small write and the
      // socket/notification consumers read the row back), the rest is fire-and-forget.
      await ChatRepo.setMessageTriage(parentMessageId, consultationId, triage).catch((err) =>
        logger.warn("Jev triage: failed to persist triage on message", { err, consultationId, messageId: parentMessageId }),
      );
      emitEvent("chat:triage", {
        urgent: triage.urgent,
        probability: triage.probability,
        intent: triage.intent,
        intentConfidence: triage.intentConfidence,
        refersToAttachment: triage.refersToAttachment,
        missingAttachment: !hasAttachedMaterial,
      });
      // notificationFor decides whether anyone else should hear about this turn; this just
      // hands it the result and never blocks generation on the outcome. Skipped on an
      // already-aborted job: the user pressed Stop, so pinging the rest of the team about a
      // turn that is being thrown away would be noise. The triage row above is still written —
      // it records what was asked, which stays true whether or not the reply was produced.
      if (!signal.aborted) {
        void ChatSvc.notifyTriagedMessage(consultation, userId, userInput, triage, effectiveCaseId).catch((err) =>
          logger.warn("Jev triage: failed to raise notification", { err, consultationId, messageId: parentMessageId }),
        );
      }
    }

    const resolvedContext = [caseContext, mindMapChangesContext, documentContext, groundingContext, transcriptContext, triageContext]
      .filter(Boolean)
      .join("\n\n");
    logger.info("Chat: grounding/RAG context resolved", {
      consultationId,
      messageId: parentMessageId,
      caseDocumentChunks: grounding?.caseDocumentIds.length ?? 0,
      transcriptChunks: transcriptGrounding?.transcriptionIds.length ?? 0,
      mindMapChangesChars: mindMapChangesContext.length,
      urgent: triage?.urgent ?? false,
      intent: triage?.intent ?? null,
      contextChars: resolvedContext.length,
      elapsedMs: Date.now() - t0,
    });

    if (signal.aborted) {
      logger.info("Chat generation: cancelled during context resolution", { jobId: parentMessageId, consultationId });
      return;
    }

    const cacheKey = responseCacheKey(
      consultationId,
      userInput,
      resolvedContext,
      groundingCacheKey(grounding),
    );
    const cached = await redis.get<{
      content: string;
      relatedCases: RelatedCase[];
      mindMap?: MindMapItem;
      timeline?: TimelineItem[];
      audioOverview?: AudioOverviewTurn[];
      reasoning?: ReasoningExplanation;
      decisions?: DecisionRecordsPayload;
      draftedDocument?: { content: string; format: "docx" | "pdf"; documentType?: string; documentName?: string };
      researchSteps?: TraceStep[];
    }>(cacheKey);
    // Map-generation turns used to cache text-only replies (the mind map arrives on a
    // later Chat Wonder frame). A hit without mindMap would keep the tab empty for TTL.
    const wantsMindMap = /visual strategy map|mind\s*map/i.test(userInput);
    // Same trigger check as the_server.py's _wants_audio_overview. Unlike mind map, Audio
    // Overview is meant to produce a fresh script on every explicit generate click (the tile's
    // onClick always calls this) — so it must never read from the response cache, only skip
    // writing to it would still leave the very next click hitting the stale entry from this one.
    const wantsAudioOverview = /audio overview/i.test(userInput);
    const useCache =
      Boolean(cached) && !wantsAudioOverview && (!wantsMindMap || cached?.mindMap);
    logger.info("Chat: response cache checked", {
      consultationId,
      messageId: parentMessageId,
      cacheHit: Boolean(cached),
      useCache,
      elapsedMs: Date.now() - t0,
    });

    // Checkpoints the raw accumulated reply into the user message's pendingReplyContent every
    // CHECKPOINT_INTERVAL_MS, so a mid-generation browser refresh can show the partial answer
    // instead of a bare "thinking" indicator until the real reply is persisted (see
    // Message.replyStatus's doc comment). This is the refresh-safe, durable progress record —
    // it exists independently of whether anyone is connected to the socket below. Throttled
    // and chained (not fired per-chunk) since Chat Wonder can emit many chunks a second.
    const CHECKPOINT_INTERVAL_MS = 1_000;
    let lastCheckpointAt = 0;
    let checkpointChain: Promise<unknown> = Promise.resolve();
    let accumulatedForCheckpoint = "";
    let chunkCount = 0;
    control.getPartial = () => accumulatedForCheckpoint;
    const checkpointedOnChunk = (text: string) => {
      // A chunk already in flight when Stop landed: drop it — the saved partial reply and the
      // client's frozen bubble must both end at the same point.
      if (signal.aborted) return;
      // Best-effort live push for a browser actively connected right now — emitToUser is a
      // no-op if nobody's listening (tab refreshed/closed, or never had a socket). This is
      // purely a UX nicety on top of the durable checkpoint above, never load-bearing for
      // correctness: a disconnected/refreshed client falls back to the messages API and
      // reading pendingReplyContent, same as it always could.
      text = redactDocumentIds(text, scopeDocs);
      emitEvent("chat:chunk", { chunk: text });
      chunkCount++;
      if (chunkCount === 1) {
        logger.info("Chat generation: first chunk emitted", { jobId: parentMessageId, consultationId, elapsedMs: Date.now() - t0 });
      }
      accumulatedForCheckpoint += text;
      const now = Date.now();
      if (now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        lastCheckpointAt = now;
        const snapshot = accumulatedForCheckpoint;
        checkpointChain = checkpointChain
          .then(() => ChatRepo.checkpointPendingReply(parentMessageId, snapshot))
          .catch((err) => logger.warn("Chat: pending-reply checkpoint failed", { err, messageId: parentMessageId }));
      }
    };

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    let streamedMindMap: MindMapItem | undefined;
    let streamedTimeline: TimelineItem[] | undefined;
    // Which case documents' full text actually went into this turn's payload. The grounding
    // verifier needs the truth of what the model was given, not what the case holds (see
    // GroundingVerifierSvc): a "not reproduced in the available extract" line is a defect only if
    // the text was there. A cached reply leaves this empty, which is why the verifier is skipped
    // on the cache path rather than told a comfortable lie.
    let inlinedCaseDocumentIds: string[] = [];
    let streamedAudioOverview: AudioOverviewTurn[] | undefined;
    let streamedReasoning: ReasoningExplanation | undefined;
    let streamedDecisions: DecisionRecordsPayload | undefined;
    let streamedDraftedDocument: { content: string; format: "docx" | "pdf"; documentType?: string; documentName?: string } | undefined;
    let streamedResearchSteps: TraceStep[] | undefined;
    // A cache hit replays a reply generated against some earlier turn's grounding, so this turn
    // has no record of what text the model saw. The grounding verifier is skipped rather than run
    // on that unknown — see the call site below.
    let usedCachedResponse = false;
    try {
      if (useCache && cached) {
        usedCachedResponse = true;
        checkpointedOnChunk(cached.content);
        fullResponse = cached.content;
        relatedCases = cached.relatedCases;
        streamedMindMap = cached.mindMap;
        streamedTimeline = cached.timeline;
        streamedAudioOverview = cached.audioOverview;
        streamedReasoning = cached.reasoning;
        streamedDecisions = cached.decisions;
        streamedDraftedDocument = cached.draftedDocument;
        streamedResearchSteps = cached.researchSteps;
      } else {
        // Guards against a duplicate mind-map/audio-overview generation if a page refresh mid-
        // stream makes the CTA look idle again (see AiGenerationJob) — ordinary chat turns are
        // untouched, since there's no "duplicate generate" concern for two different questions.
        const generationKind = wantsMindMap ? "mindMap" : wantsAudioOverview ? "audioOverviewScript" : null;
        const aiCallStartedAt = Date.now();
        logger.info("Chat: AI call starting", {
          consultationId,
          messageId: parentMessageId,
          sessionId,
          generationKind,
          elapsedMs: aiCallStartedAt - t0,
        });
        // Chat Wonder session ids are cached client-side indefinitely; the old synchronous-
        // in-request flow told the caller about a rotation via an X-Chat-Session-Id response
        // header. There's no HTTP response left to attach that to now, so a connected client
        // instead learns about it over the socket — chat:session-rotated — and picks it up on
        // its next send regardless via the same resolveChatWonderSession redis lookup this job
        // itself resolved sessionId from at enqueue time.
        const onSessionRotated = (newSessionId: string) => {
          emitEvent("chat:session-rotated", { sessionId: newSessionId });
        };
        // A map request on a case also sends the case digest, for chat-wonder's map generator
        // (see streamChatWonderMessage's mindMapContext). Best-effort: without it the map is
        // still built, just from the answer alone — same as before.
        const mindMapContext =
          wantsMindMap && effectiveCaseId
            ? await CaseMindMapSvc.buildChatContext(effectiveCaseId).catch((err) => {
                logger.warn("Chat: case mind map context unavailable, sending the turn without it", {
                  err,
                  consultationId,
                  caseId: effectiveCaseId,
                });
                return undefined;
              })
            : undefined;
        // The case's damages model, so "how much can we claim?" quotes the panel's figures.
        // Best-effort, like the map context: a failure just sends the turn without it.
        const caseDamages = effectiveCaseId
          ? await DamageClaimSvc.chatContext(effectiveCaseId, tenantCode).catch((err) => {
              logger.warn("Chat: damages model unavailable, sending the turn without it", {
                err,
                consultationId,
                caseId: effectiveCaseId,
              });
              return undefined;
            })
          : undefined;
        // A locked generation (audio overview script, mind map) records its stage on the lock row,
        // which is what turns the panel's spinner into real steps. Fire-and-forget: setStage
        // never throws, and a late report for a finished job is dropped there.
        const lockedCaseId = generationKind ? effectiveCaseId : undefined;
        const onStage =
          generationKind && lockedCaseId
            ? (stage: ChatWonderStage) => void AiGenerationLockSvc.setStage(lockedCaseId, generationKind, stage)
            : undefined;
        const runStream = () =>
          ChatSvc.streamWithSessionRetry(
            consultationId,
            sessionId,
            effectiveUserInput,
            checkpointedOnChunk,
            resolvedContext,
            onSessionRotated,
            grounding,
            undefined,
            tenantCode,
            signal,
            // The answer text is fully streamed; the extras (timeline/mind map/reasoning/
            // decisions) and persistence are still to come before chat:done. Lets a connected
            // client stop showing "generating" (Stop) and show "finishing analysis" instead.
            // Purely a live-UX signal, like every event here; skipped once the user has stopped.
            () => {
              if (!signal.aborted) emitEvent("chat:answer-complete", {});
            },
            replyLanguage,
            // Any turn that asks for a map, case or not: chat-wonder builds one only on this flag.
            {
              mindMapRequested: wantsMindMap,
              mindMapContext: mindMapContext || undefined,
              caseDamages,
              onStage,
              // A question is traced as "chat"; the mind map and audio overview triggers, which go
              // through this same path, are traced under their own names.
              trace: {
                consultationId,
                caseId: effectiveCaseId ?? null,
                organizationId,
                source: generationKind === "mindMap" ? "mindMap" : generationKind === "audioOverviewScript" ? "audioOverview" : "chat",
                turnId: parentMessageId,
                userId: userId ?? null,
              },
            },
          );
        const result =
          generationKind && effectiveCaseId
            ? await AiGenerationLockSvc.run(effectiveCaseId, generationKind, runStream)
            : await runStream();
        logger.info("Chat: AI call finished", {
          consultationId,
          messageId: parentMessageId,
          aiCallMs: Date.now() - aiCallStartedAt,
          elapsedMs: Date.now() - t0,
          responseChars: result.content.length,
          chunksStreamed: chunkCount,
        });
        // Stop landed just as the stream completed: the reply is already saved as a partial by
        // ChatSvc.cancelChatGeneration — don't cache it or persist a second, full one.
        if (signal.aborted) return;
        fullResponse = result.content;
        relatedCases = result.relatedCases;
        streamedMindMap = result.mindMap;
        streamedTimeline = result.timeline;
        streamedAudioOverview = result.audioOverview;
        streamedReasoning = result.reasoning;
        streamedDecisions = result.decisions;
        streamedDraftedDocument = result.draftedDocument;
        streamedResearchSteps = result.researchSteps;
        inlinedCaseDocumentIds = result.inlinedCaseDocumentIds;
        redis.set(
          cacheKey,
          {
            content: fullResponse,
            relatedCases,
            mindMap: streamedMindMap,
            timeline: streamedTimeline,
            audioOverview: streamedAudioOverview,
            reasoning: streamedReasoning,
            decisions: streamedDecisions,
            draftedDocument: streamedDraftedDocument,
            researchSteps: streamedResearchSteps,
          },
          RESPONSE_CACHE_TTL,
        );
      }
    } catch (err) {
      if (err instanceof GenerationCancelledError || signal.aborted) {
        // Not a failure: the user pressed Stop. replyStatus is already CANCELLED and the partial
        // reply already saved and announced (chat:cancelled) by ChatSvc.cancelChatGeneration.
        logger.info("Chat generation: stopped by user", {
          consultationId,
          messageId: parentMessageId,
          elapsedMs: Date.now() - t0,
          chunksStreamed: chunkCount,
        });
        return;
      }
      logger.error("Chat generation: AI call failed", {
        consultationId,
        messageId: parentMessageId,
        elapsedMs: Date.now() - t0,
        err,
      });
      // Lets a freshly-loaded page tell "generation failed" from "still generating" (see
      // Message.replyStatus) instead of polling forever for a reply that's never coming — the
      // durable, refresh-safe signal. chat:error is the best-effort live counterpart for a
      // client connected right now.
      await ChatRepo.setReplyStatus(parentMessageId, "FAILED").catch(() => {});
      emitEvent("chat:error", { message: err instanceof Error ? err.message : "Generation failed" });
      logger.info("Chat generation: chat:error emitted", { jobId: parentMessageId, consultationId, reason: "ai-call-failed" });
      // Rethrown so ChatGenerationQueue's runOne logs the failure — it does NOT trigger SQS
      // redelivery (this queue always acks, see its class doc comment): replyStatus is already
      // the durable FAILED record, so a blind retry of the same prompt against Chat Wonder
      // would be wasted work, not a meaningful recovery attempt.
      throw err;
    }

    // The reply has fully streamed to any connected client by this point, but that live push
    // is a temporary, best-effort experience — it is NOT what makes the reply durable. The
    // canonical record (the assistant Message row(s): topic split, MessageGroup,
    // timeline/mind-map/audio-overview/reasoning/related-cases, replyStatus DONE) is written
    // HERE, before this job is considered complete — regardless of whether the original
    // request or any connected browser is still around to see it.
    //
    // persistAssistantTurnWithRetry retries transient DB failures with bounded backoff
    // (2s/4s/8s) before giving up — a blip delays completion instead of silently losing the
    // reply. If it still fails after retries, the job must NOT be treated as successful:
    // replyStatus is flipped to FAILED and chat:error is emitted, same as an AI failure above.
    // Whatever the AI wrote, no file id is saved or shown: names only.
    fullResponse = redactDocumentIds(fullResponse, scopeDocs);
    if (streamedDecisions) {
      streamedDecisions = await ChatSvc.sanitizeDecisionPayload(
        streamedDecisions,
        { organizationId, consultationId, caseId: effectiveCaseId ?? consultation.caseId },
        scopeDocs,
      );
    }

    const assistantTurnPayload: AssistantTurnPayload = {
      consultationId,
      parentMessageId,
      effectiveCaseId: effectiveCaseId ?? null,
      userId,
      tenantCode,
      fullResponse,
      relatedCases,
      mindMap: streamedMindMap,
      timeline: streamedTimeline,
      audioOverview: streamedAudioOverview,
      reasoning: streamedReasoning,
      decisions: streamedDecisions,
      draftedDocument: streamedDraftedDocument,
      researchSteps: streamedResearchSteps,
    };

    // A Stop on another instance may not have reached this job's abort signal yet (the poll runs
    // once a second) — the durable status is the tiebreaker, so a cancelled turn never also gets
    // a full reply persisted next to its saved partial one.
    const stateBeforePersist = await ChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (signal.aborted || stateBeforePersist?.replyStatus === "CANCELLED") {
      logger.info("Chat generation: cancelled before persistence, dropping reply", { jobId: parentMessageId, consultationId });
      return;
    }

    let assistantMessage: { id: string } | null;
    try {
      assistantMessage = await ChatSvc.persistAssistantTurnWithRetry(assistantTurnPayload);
    } catch (err) {
      logger.error("Chat generation: canonical persistence failed after retries — response was NOT saved", {
        consultationId,
        messageId: parentMessageId,
        elapsedMs: Date.now() - t0,
        err,
      });
      await ChatRepo.setReplyStatus(parentMessageId, "FAILED").catch(() => {});
      emitEvent("chat:error", { message: "Failed to save the assistant response" });
      logger.info("Chat generation: chat:error emitted", { jobId: parentMessageId, consultationId, reason: "persistence-failed" });
      throw err;
    }

    logger.info("Chat generation: assistant message persisted", {
      consultationId,
      messageId: parentMessageId,
      assistantMessageId: assistantMessage?.id,
      elapsedMs: Date.now() - t0,
    });

    // chat:done fires ONLY after canonical persistence has already succeeded above — a
    // connected client can trust it to mean "GET /messages will include this now," never a
    // "trust me, it's coming" signal. Never load-bearing either way: a disconnected/refreshed
    // client reaches the same conclusion by re-fetching messages and seeing replyStatus DONE.
    if (assistantMessage) {
      emitEvent("chat:done", { assistantMessageId: assistantMessage.id });
      logger.info("Chat generation: chat:done emitted", {
        jobId: parentMessageId,
        consultationId,
        assistantMessageId: assistantMessage.id,
      });
    }

    if (needsTitle && assistantMessage) {
      void ChatSvc.titleAfterReply({
        consultationId,
        tenantCode,
        userId,
        userInput: effectiveUserInput,
        typedInput: userInput,
        attachmentNames,
        fullResponse,
        firstPass: titlePass,
      });
    }

    // Grounding verification (docs/plans/grounding-verifier.md). Deliberately after chat:done:
    // the lawyer already has the reply, and this only attaches what the bundle says about the
    // claims in it. Fire-and-forget, never awaited — GroundingVerifierSvc.verifyAnswer swallows
    // its own failures, and this `void` is the second guarantee that a verification problem can
    // never become a chat problem. Skipped on the cache path, where inlinedCaseDocumentIds is
    // empty and every disclaimer would be misread as NOT_SUPPLIED.
    if (assistantMessage && effectiveCaseId && GroundingVerifierSvc.enabled && !usedCachedResponse) {
      const verifiedMessageId = assistantMessage.id;
      void GroundingVerifierSvc.verifyAnswer({
        assistantMessageId: verifiedMessageId,
        caseId: effectiveCaseId,
        answer: fullResponse,
        rankedDocumentIds: grounding?.caseDocumentIds ?? [],
        inlinedDocumentIds: inlinedCaseDocumentIds,
      })
        .then((counts) => {
          if (counts.checked) emitEvent("chat:grounding", { assistantMessageId: verifiedMessageId, ...counts });
        })
        .catch((err) => logger.warn("Grounding verifier: unexpected rejection", { err, consultationId, messageId: parentMessageId }));
    }

    // Citation ranking (src/utils/citation-rank.ts). Also after chat:done and also fire-and-forget:
    // the answer is already saved, and this only attaches a relevance tier per cited authority, read
    // from the user's message and never from the answer. Unlike the grounding verifier it is not
    // gated on a case id, and it runs on the cache path too because it reads the saved reply.
    // CitationRankSvc.rankReply never throws; a failure leaves every link neutral.
    if (assistantMessage && CitationRankSvc.enabled) {
      const rankedMessageId = assistantMessage.id;
      void CitationRankSvc.rankReply({ parentMessageId, tenantCode })
        .then((r) => {
          if (r.ranked) emitEvent("chat:citation-ranking", { assistantMessageId: rankedMessageId, ranked: r.ranked });
        })
        .catch((err) => logger.warn("Citation ranking: unexpected rejection", { err, consultationId, messageId: parentMessageId }));
    }

    // Only now enqueue the secondary/background work — case-graph enrichment (promoting the
    // AI's timeline/decisions into the case's own Timeline/DecisionRecord tables). This runs
    // AFTER canonical persistence, not before it: its own failure (SQS down, worker crash) must
    // never affect whether the chat message exists — it already does, durably, in the DB.
    // Gated on effectiveCaseId here (not just left to CaseGraphPromotionQueue's own timeline/
    // decisions-presence guard): a general, non-case consultation has no case graph to promote
    // into, so it must not enqueue at all — not "enqueue a job that then no-ops," an entirely
    // skipped round trip through SQS.
    // enqueue() is designed to never throw (its own SQS-send failure is caught internally and
    // falls back to an in-process retry — see CaseGraphPromotionQueue), but it's wrapped here
    // too: even a bug in that path must not turn an already-persisted, already-durable reply
    // into a failed job.
    if (assistantMessage && effectiveCaseId) {
      try {
        CaseGraphPromotionQueue.enqueue({
          consultationId,
          parentMessageId,
          assistantMessageId: assistantMessage.id,
          effectiveCaseId,
          userId,
          timeline: streamedTimeline,
          decisions: streamedDecisions,
          enqueuedAt: Date.now(),
        });
      } catch (err) {
        logger.error("Chat generation: failed to enqueue case graph promotion — message is still durable", {
          consultationId,
          messageId: parentMessageId,
          assistantMessageId: assistantMessage.id,
          err,
        });
      }
    }

    logger.info("Chat generation: job completed (persisted, background work queued)", {
      consultationId,
      messageId: parentMessageId,
      chunksStreamed: chunkCount,
      totalMs: Date.now() - t0,
    });
  }

  /** persistAssistantTurn with bounded exponential backoff — the worker-path retry for
   * canonical persistence (see processChatGenerationJob). A `null` return (not a thrown error)
   * means the consultation was deleted concurrently — an expected, non-retryable no-op, not a
   * failure. */
  private static async persistAssistantTurnWithRetry(
    payload: AssistantTurnPayload,
  ): Promise<{ id: string } | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= PERSIST_RETRIES; attempt++) {
      try {
        return await this.persistAssistantTurn(payload);
      } catch (err) {
        lastErr = err;
        if (attempt < PERSIST_RETRIES) {
          const delay = PERSIST_RETRY_BASE_MS * 2 ** attempt;
          logger.warn("Chat: canonical persistence attempt failed, retrying", {
            err,
            attempt: attempt + 1,
            retryInMs: delay,
            parentMessageId: payload.parentMessageId,
          });
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  /**
   * Persists a chat turn's assistant reply — the CANONICAL, durable record of a completed AI
   * response (topic-split Message row(s), timeline/mind-map/audio-overview/reasoning/related-
   * cases, replyStatus DONE). Called synchronously from sendMessage, in the request path, right
   * after AI generation (or a cache replay) finishes and BEFORE the HTTP response ends — the
   * request is only considered successfully completed once this write lands, so a browser
   * refresh immediately afterward always finds the reply via GET /messages.
   *
   * This intentionally does NOT promote the timeline/decisions into the case graph
   * (CaseTimelineSvc/DecisionRecordSvc) — that's secondary/background enrichment, done by
   * promoteAssistantTurnToCaseGraph via CaseGraphPromotionQueue, enqueued only after this
   * function returns successfully. A failure in that later, async step can never make the
   * message created here disappear.
   *
   * Idempotent by parentMessageId — a retry from persistAssistantTurnWithRetry after a partial
   * failure (e.g. the message row was created but a structured-extra write then threw) finds
   * the already-created row here and returns it rather than splitting the reply into duplicate
   * sibling rows. Returns null (not an error) if the consultation was deleted concurrently —
   * an expected, non-retryable no-op.
   */
  static async persistAssistantTurn(p: AssistantTurnPayload): Promise<{ id: string } | null> {
    const t0 = Date.now();
    const alreadyPersisted = await ChatRepo.findAssistantReplyByParent(p.parentMessageId);
    if (alreadyPersisted) {
      logger.info("Message persistence: assistant turn already persisted, skipping", {
        parentMessageId: p.parentMessageId,
      });
      // A retried/redelivered call after a crash between saving and acking — the earlier run
      // may not have reached the DONE mark below, so this idempotent path still applies it.
      await ChatRepo.setReplyStatus(p.parentMessageId, "DONE", { clearPendingContent: true }).catch(() => {});
      return alreadyPersisted;
    }

    // The consultation can be deleted by the user in a separate concurrent request while this
    // one is still generating — every write below has a consultationId FK, so that's not a
    // transient error worth retrying (persistAssistantTurnWithRetry would otherwise burn all
    // its backoff attempts on a P2003 foreign key violation that's never going away), it's
    // permanent: the row is never coming back.
    if (!(await ChatRepo.findConsultationById(p.consultationId))) {
      logger.warn("Message persistence: consultation no longer exists, dropping turn", {
        consultationId: p.consultationId,
        parentMessageId: p.parentMessageId,
      });
      return null;
    }

    // audioOverview/reasoning have no text-fallback re-parse (unlike timeline/mindMap) — they
    // only ever arrive as Chat Wonder's own dedicated frames, never inline in fullResponse.
    const timeline = p.timeline ?? extractTimeline(p.fullResponse);
    const mindMap = p.mindMap ?? extractMindMap(p.fullResponse);
    const audioOverview = p.audioOverview;
    const reasoning = p.reasoning;
    const decisions = p.decisions;
    let cleanedContent = stripStructuredBlocks(p.fullResponse);
    const {
      content: rewrittenContent,
      rewrittenCount,
      attemptedCount,
      strippedCount,
    } = await rewriteLegalCitationLinks(cleanedContent, p.tenantCode).catch((err) => {
      logger.warn("Message persistence: citation link rewrite failed, keeping original links", {
        err,
        parentMessageId: p.parentMessageId,
      });
      return { content: cleanedContent, rewrittenCount: 0, attemptedCount: 0, strippedCount: 0 };
    });
    cleanedContent = rewrittenContent;
    if (attemptedCount > 0 || strippedCount > 0) {
      logger.info("Message persistence: legal citation links rewritten", {
        parentMessageId: p.parentMessageId,
        rewrittenCount,
        attemptedCount,
        strippedCount,
      });
    }
    const topics = splitIntoTopics(cleanedContent);

    // A split reply becomes several sibling assistant Messages under one new MessageGroup —
    // one bubble per topic. The structured extras still describe the whole turn, so they
    // anchor to the LAST topic message (greatest createdAt — see ChatRepo.findLatestAssistantMessage).
    let assistantMessage: Awaited<ReturnType<typeof ChatRepo.createMessage>>;
    if (topics && topics.length > 1) {
      const group = await ChatRepo.createMessageGroup(p.consultationId);
      // Sequential (not Promise.all) so createdAt strictly increases in groupOrder order.
      const topicMessages: Awaited<ReturnType<typeof ChatRepo.createMessage>>[] = [];
      for (const [index, topic] of topics.entries()) {
        topicMessages.push(
          await ChatRepo.createMessage(
            p.consultationId,
            "assistant",
            topic.content,
            undefined,
            p.parentMessageId,
            group.id,
            index,
            topic.title,
          ),
        );
      }
      assistantMessage = topicMessages[topicMessages.length - 1];
    } else {
      assistantMessage = await ChatRepo.createMessage(
        p.consultationId,
        "assistant",
        cleanedContent,
        undefined,
        p.parentMessageId,
      );
    }

    logger.info("Message persistence: assistant message row(s) created", {
      parentMessageId: p.parentMessageId,
      assistantMessageId: assistantMessage.id,
      elapsedMs: Date.now() - t0,
    });

    if (timeline) await ChatRepo.saveTimeline(assistantMessage.id, timeline);
    if (mindMap) await ChatRepo.saveMindMap(assistantMessage.id, mindMap);
    if (audioOverview) {
      const { hostA, hostB } = voicePairForCase(p.effectiveCaseId ?? p.consultationId);
      await ChatRepo.saveAudioOverview(assistantMessage.id, audioOverview, hostA, hostB)
        .then(() => ChatSvc.checkAudioOverviewInBackground(assistantMessage.id, audioOverview, p.effectiveCaseId, p.userId))
        .catch((err) => {
          logger.error("Failed to persist Audio Overview script", { err, messageId: assistantMessage.id });
        });
    }
    if (reasoning) {
      await ChatRepo.saveReasoning(assistantMessage.id, reasoning).catch((err) => {
        logger.error("Failed to persist reasoning explanation", { err, messageId: assistantMessage.id });
      });
    }
    if (decisions?.records.length) {
      // Case-graph promotion (CaseTimelineSvc/DecisionRecordSvc) happens later, off-request,
      // via promoteAssistantTurnToCaseGraph — see that method's doc comment. This row (the
      // turn's own record of its decisions) is part of the canonical message, though, so it's
      // still saved here, synchronously.
      await ChatRepo.saveDecisionRecords(assistantMessage.id, decisions).catch((err) => {
        logger.error("Failed to persist decision records", { err, messageId: assistantMessage.id });
      });
    }
    if (p.draftedDocument) {
      // Rendered here, synchronously, in-process — no HTTP hop to ourselves. See #71.
      try {
        const { file } = await GeneratedDocumentExportSvc.export(
          p.draftedDocument.content,
          p.draftedDocument.documentName || p.draftedDocument.documentType || "Document",
          p.draftedDocument.format,
        );
        await ChatRepo.saveGeneratedDocument(assistantMessage.id, {
          fileId: file.id,
          documentType: p.draftedDocument.documentType,
          documentName: p.draftedDocument.documentName,
        });
      } catch (err) {
        logger.error("Failed to render/persist generated document", { err, messageId: assistantMessage.id });
      }
    }
    if (p.researchSteps?.length) {
      await ChatRepo.saveResearchSteps(assistantMessage.id, p.researchSteps).catch((err) => {
        logger.error("Failed to persist research steps", { err, messageId: assistantMessage.id });
      });
    }
    if (p.relatedCases.length) await ChatRepo.saveRelatedCases(assistantMessage.id, p.relatedCases);

    await ChatRepo.setReplyStatus(p.parentMessageId, "DONE", { clearPendingContent: true }).catch((err) => {
      logger.error("Message persistence: failed to mark parent message DONE", {
        err,
        parentMessageId: p.parentMessageId,
      });
    });

    logger.info("Message persistence: assistant turn persisted", {
      parentMessageId: p.parentMessageId,
      consultationId: p.consultationId,
      assistantMessageId: assistantMessage.id,
      topicCount: topics && topics.length > 1 ? topics.length : 1,
      durationMs: Date.now() - t0,
    });

    return { id: assistantMessage.id };
  }

  /**
   * Case-graph enrichment for an already-persisted chat turn: promotes its decision records into
   * the case's DecisionRecord table + CaseGraph nodes/edges (DecisionRecordSvc.promote). Called
   * from CaseGraphPromotionQueue, after ChatSvc.persistAssistantTurn has already durably created
   * the assistant Message this enriches — this step is a nice-to-have on top of an already-
   * complete, already-visible reply, never a prerequisite for it.
   *
   * Idempotent: DecisionRecordSvc.promote does not dedupe on its own (each call is meant to add new
   * records), so a guard here checks for records already promoted from this assistantMessageId
   * before calling it — needed now that SQS redelivery of this job is the only thing that would
   * otherwise call promote() twice for the same turn.
   */
  static async promoteAssistantTurnToCaseGraph(p: CaseGraphPromotionPayload): Promise<void> {
    if (!p.effectiveCaseId) return;

    // The answer's timeline is no longer copied into the case's Timeline: chat dates carry no
    // document, and the case timeline holds only dates found in the documents (CaseStrategySvc).

    if (p.decisions?.records.length) {
      const alreadyPromoted = await DecisionRecordRepo.existsForSourceMessage(p.assistantMessageId);
      if (alreadyPromoted) {
        logger.info("Case graph promotion: decisions already promoted for this turn, skipping", {
          assistantMessageId: p.assistantMessageId,
        });
      } else {
        await DecisionRecordSvc.promote(p.effectiveCaseId, p.assistantMessageId, p.decisions.records).catch((err) => {
          logger.error("Failed to promote decision records into the case graph", {
            err,
            caseId: p.effectiveCaseId,
            messageId: p.assistantMessageId,
          });
        });
      }
    }
  }

  /** Chat Wonder keeps sessions in memory and drops them on restart; the frontend caches
   * its session_id indefinitely (including across login/logout), so a "session_id not
   * recognized" rejection from streamChatWonderMessage is an expected, recoverable event
   * rather than a real failure. "Unknown session." is always the very first frame Chat
   * Wonder sends for this case (see the_server.py's chat_stream handler), before any real
   * content — so retrying from scratch here can't cause onChunk to double-emit content. */
  private static async streamWithSessionRetry(
    consultationId: string,
    sessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    resolvedContext: string,
    onSessionRotated?: (newSessionId: string) => void,
    grounding?: CaseDocumentGrounding,
    caseId?: string,
    tenantCode?: TenantCode,
    signal?: AbortSignal,
    onAnswerComplete?: () => void,
    replyLanguage?: string,
    extras?: {
      mindMapRequested: boolean;
      mindMapContext?: string;
      caseDamages?: CaseDamagesChatContext;
      onStage?: (stage: ChatWonderStage) => void;
      /** Set on a real user turn: records its customer-facing trace for the Terminal's trace pane. */
      trace?: TraceTurn;
    },
  ) {
    // Map fields only on a turn that asked for a map; the damages model on any case turn.
    const opts =
      extras?.mindMapRequested || extras?.caseDamages || extras?.onStage || extras?.trace
        ? {
            ...(extras.mindMapRequested ? { mindMapRequested: true, mindMapContext: extras.mindMapContext } : {}),
            ...(extras.caseDamages ? { caseDamages: extras.caseDamages } : {}),
            ...(extras.onStage ? { onStage: extras.onStage } : {}),
            ...(extras.trace ? { traceTurnId: extras.trace.turnId } : {}),
          }
        : undefined;
    // Subscribed before the turn is sent (chat-wonder fans events out live, with no replay), and
    // never allowed to fail the turn — see TraceCollectorSvc.
    const collector = extras?.trace ? await TraceCollectorSvc.start(extras.trace, sessionId) : undefined;
    // The turn's "why this answer", closing its trace once the turn is over (see TraceCollector.stop).
    let reasoning: ReasoningExplanation | undefined;
    try {
      try {
        const result = await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode, signal, onAnswerComplete, replyLanguage, opts);
        reasoning = result.reasoning;
        return result;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
        const freshSessionId = await ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
        // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
        // set a response header — nothing has been written to the HTTP response yet at
        // this point, since "Unknown session." always arrives before any real content.
        onSessionRotated?.(freshSessionId);
        // The trace follows the turn onto the new session, so the log stays one continuous record.
        await collector?.rebind(freshSessionId);
        const result = await streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode, signal, onAnswerComplete, replyLanguage, opts);
        reasoning = result.reasoning;
        return result;
      }
    } finally {
      await collector?.stop(reasoning);
    }
  }

  /** One Chat Wonder session per consultation so case-document history cannot leak across cases. */
  private static async resolveChatWonderSession(consultationId: string): Promise<string> {
    const stored = await redis.get<string>(chatWonderSessionKey(consultationId));
    if (typeof stored === "string" && stored.length > 0) {
      await redis.set(chatWonderSessionKey(consultationId), stored, CHAT_WONDER_SESSION_TTL_S);
      return stored;
    }
    return ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
  }

  private static async storeChatWonderSession(consultationId: string, sessionId: string): Promise<string> {
    await redis.set(chatWonderSessionKey(consultationId), sessionId, CHAT_WONDER_SESSION_TTL_S);
    return sessionId;
  }

  /** Ignore a client-supplied document id unless it belongs to this consultation or case, and
   * unless it's still ACTIVE — an archived document is excluded from chat entirely (Option A of
   * the "Archived Documents in Chat" plan), not just from auto-selection. Falling through to
   * `undefined` here degrades to sendMessage's next grounding path (consultation/case auto-search,
   * which itself excludes archived documents via relevantChunksForScope) rather than erroring —
   * same best-effort shape as every other grounding fallback in this file. */
  private static async scopedCaseDocumentId(
    caseDocumentId: string | undefined,
    organizationId: string,
    userId: string,
    consultationId: string,
    caseId?: string,
  ): Promise<string | undefined> {
    if (!caseDocumentId) return undefined;
    // findById is scoped by ORGANIZATION. This used to pass the user id here, which never matches
    // an organization id, so an explicitly attached document was silently never used for grounding.
    // documentBelongsToScope below still requires the uploading user, the consultation or the case.
    const doc = await DocumentRepo.findById(caseDocumentId, organizationId);
    if (!doc) return undefined;
    if (doc.status === "ARCHIVED") return undefined;
    if (!documentBelongsToScope(doc, { userId, consultationId, caseId })) return undefined;
    return doc.id;
  }

  static async getRelatedCases(organizationId: string, tenantCode: TenantCode, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

    const message = await ChatRepo.findLatestAssistantMessage(consultationId);
    const items = await enrichRelatedCaseTitles((message?.relatedCases?.items ?? []) as unknown as RelatedCase[]);
    // Enrichment runs first so a related case that arrived with only a bare URL (no
    // title/case_number/ra_number) has a real title by the time Library resolution needs a
    // label for its slow (materialize-on-first-sight) path.
    return resolveRelatedCaseLibraryLinks(items, tenantCode);
  }

  /** Starts rendering the audio for a message's already-generated Audio Overview script
   * (see sendMessage's audioOverview handling above) — the separate, explicit "Generate
   * Audio" action from the grilling session's plan, never auto-triggered from script
   * generation. Enqueues onto AudioOverviewQueue and returns immediately. */
  static async startAudioOverviewAudio(organizationId: string, consultationId: string, messageId: string) {
    await ChatSvc.assertConsultationOwned(organizationId, consultationId);
    const message = await ChatRepo.findMessageById(messageId);
    if (!message || message.consultationId !== consultationId) {
      throw new HttpError("Message not found", 404);
    }
    const row = await ChatRepo.findAudioOverviewByMessageId(messageId);
    if (!row) throw new HttpError("No Audio Overview script for this message yet", 404);

    await ChatRepo.updateAudioOverviewAudio(row.id, { audioStatus: "IN_PROGRESS" });
    AudioOverviewQueue.enqueue(row.id);
    return { status: "IN_PROGRESS" as const };
  }

  /** Fire-and-forget Jev check of a just-saved script — logs rather than throws, since nothing
   * is waiting on it. Needs a case to read the case data from; a case-less consultation has none. */
  private static checkAudioOverviewInBackground(
    messageId: string,
    turns: AudioOverviewTurn[],
    caseId: string | null,
    userId: string,
  ): void {
    if (!isAudioOverviewJevEnabled() || !caseId) return;
    void (async () => {
      const context = await CaseMindMapSvc.jevContext(caseId, userId);
      const checks = await checkAudioOverviewTurns(turns, context);
      if (checks.length) await ChatRepo.saveAudioOverviewChecks(messageId, checks);
    })().catch((err) => {
      logger.warn("Audio Overview: Jev check failed", { err, messageId });
    });
  }

  static async pollAudioOverviewAudio(organizationId: string, consultationId: string, messageId: string) {
    await ChatSvc.assertConsultationOwned(organizationId, consultationId);
    const row = await ChatRepo.findAudioOverviewByMessageId(messageId);
    if (!row) throw new HttpError("No Audio Overview script for this message", 404);

    if (row.audioStatus === "COMPLETED" && row.audioFile?.s3Key) {
      return {
        status: "COMPLETED" as const,
        audioFile: {
          id: row.audioFile.id,
          fileUrl: getProxyFileUrl(row.audioFile.s3Key, {
            filename: audioOverviewFilename(row.createdAt),
            audit: { kind: "audio_overview", id: row.id },
          }),
        },
        turnTimings: (row.turnTimings as unknown as number[] | null) ?? null,
        sentenceTimings: (row.sentenceTimings as unknown as MarkTiming[][] | null) ?? null,
        wordTimings: (row.wordTimings as unknown as MarkTiming[][] | null) ?? null,
      };
    }
    if (row.audioStatus === "FAILED") return { status: "FAILED" as const };
    return { status: "IN_PROGRESS" as const };
  }

  /** tenantCode defaults to PH to preserve scripts/backfill-titles.ts's existing single-arg
   * call signature — callers that know the tenant's actual tenantCode (generateAndSaveTitle
   * below) must pass it explicitly. */
  static buildTitlePrompt(userMessage: string, tenantCode: TenantCode = "PH", context: ChatTitleContext = {}): string {
    return getChatTitlePromptBuilder(tenantCode)(userMessage, context);
  }

  static parseTitle(raw: string): string {
    return raw
      .split("\n")[0]
      // Double quotes never belong in a title; single quotes only as apostrophes inside a word
      // ("Driver's"). Quotes the model puts around a word ('Hi') are dropped as a pair instead of
      // one end being trimmed off and the other left dangling.
      .replace(/["\u201C\u201D]/g, "")
      // (\u2026except a plural possessive: "Parents' Custody" keeps its apostrophe.)
      .replace(/(^|[\s(])['\u2018\u2019]|['\u2018\u2019](?=[),:;.!?]|$)|(?<![sS])['\u2018\u2019](?=\s)/g, "$1")
      .replace(/\.$/, "")
      .trim()
      .slice(0, TITLE_MAX_CHARS);
  }

  /** The title prompts' "only a greeting / small talk" answer (see SMALL_TALK_TITLE_SENTINEL). */
  static isSmallTalkTitle(title: string): boolean {
    return title.trim().toUpperCase().replace(/[^A-Z_]/g, "") === SMALL_TALK_TITLE_SENTINEL;
  }

  /** True when a parsed title is the title prompts' explicit "couldn't confidently categorize
   * this" escape hatch (see UNCLEAR_TITLE_SENTINEL's doc comment) rather than a real title —
   * callers should treat this the same as no title at all, never save it verbatim. */
  static isUnclearTitle(title: string): boolean {
    return title.trim().toUpperCase() === UNCLEAR_TITLE_SENTINEL;
  }

  /** True only for a real "[Legal Area]: [Specific Issue]" title (the format both tenants' title
   * prompts require). Chat Wonder returns upstream failures as ordinary content — e.g.
   * "[Error] Error code: 429 - ..." when the model is rate-limited — which parseTitle would
   * otherwise happily save (and redis-cache) as the consultation's title, and which the
   * frontend then surfaces as a suggested prompt. A model reply that ignores the format
   * (echoing the user's non-legal message, small talk) is rejected the same way. */
  static isValidTitle(title: string): boolean {
    const t = title.trim();
    if (!t || /^\[?error\]?/i.test(t)) return false;
    return /^[^:]{2,}:\s*\S/.test(t);
  }

  /** "saved" — a title was written. "unclear" — the model deliberately declined (nothing coherent
   * to title). "failed" — no usable reply from the model (empty, error text, off-format), which
   * says nothing about the input — titleAfterReply retries those and, failing again, falls back
   * to a title built from the message/file names rather than leaving it untitled. */
  private static async generateAndSaveTitle(
    consultationId: string,
    userMessage: string,
    tenantCode: TenantCode,
    userId: string,
    context: ChatTitleContext = {},
  ): Promise<TitleOutcome> {
    // Keyed on the attachment names too: the same vague "what is this?" over different files
    // must not reuse one cached title. Never cached with a reply excerpt (unique per turn).
    const cacheable = !context.replyExcerpt;
    const cacheKey = titleCacheKey(
      [userMessage, ...(context.attachmentNames ?? [])].join("\n"),
      tenantCode,
    );
    const startedAt = Date.now();

    let title = cacheable ? await redis.get<string>(cacheKey) : null;
    // Titles cached before isValidTitle existed may be error text — regenerate instead.
    if (title && !ChatSvc.isValidTitle(title)) title = null;

    if (title) {
      logger.info("Chat title: cache hit", { consultationId, tenantCode });
    } else {
      const raw = await generateTitleViaWs(ChatSvc.buildTitlePrompt(userMessage, tenantCode, context));
      if (!raw) {
        logger.info("Chat title: model returned no content", {
          consultationId,
          tenantCode,
          elapsedMs: Date.now() - startedAt,
        });
        return "failed";
      }
      title = ChatSvc.parseTitle(raw);
      // Left untitled rather than saved — gibberish/unclear input stays untitled (frontend
      // falls back to "Untitled consultation") instead of a fabricated legal category, and
      // since consultation.title stays null, the next message's send retries generation with
      // whatever the user says next.
      if (title && ChatSvc.isUnclearTitle(title)) {
        logger.info("Chat title: model returned UNCLEAR_INPUT sentinel (working as intended)", {
          consultationId,
          tenantCode,
          raw: raw.slice(0, 120),
        });
        return "unclear";
      }
      if (title && ChatSvc.isSmallTalkTitle(title)) {
        logger.info("Chat title: greeting/small talk, provisional title", { consultationId, tenantCode });
        return "smalltalk";
      }
      if (!title || !ChatSvc.isValidTitle(title)) {
        logger.warn("Chat title: model reply wasn't a valid title (empty, error text or off-format)", {
          consultationId,
          tenantCode,
          raw: raw.slice(0, 120),
        });
        return "failed";
      }
      if (cacheable) redis.set(cacheKey, title, TITLE_CACHE_TTL);
    }

    const saved = await ChatSvc.saveTitle(consultationId, userId, title, "AUTO");
    logger.info(saved ? "Chat title: saved" : "Chat title: user renamed it meanwhile, not overwritten", {
      consultationId,
      tenantCode,
      title,
      elapsedMs: Date.now() - startedAt,
    });
    return "saved";
  }

  /** A provisional title only fills an empty slot — an existing provisional title is left as it
   * is rather than flipping between "New Consultation" and "Unclear Request" each message. */
  private static async saveProvisionalIfUntitled(consultationId: string, userId: string, title: string): Promise<void> {
    const current = await ChatRepo.findConsultationTitleState(consultationId);
    if (current?.title) return;
    await ChatSvc.saveTitle(consultationId, userId, title, "PROVISIONAL");
  }

  /** Saves an AI/provisional title unless the user has set their own (see saveGeneratedTitle). */
  private static async saveTitle(
    consultationId: string,
    userId: string,
    title: string,
    source: "AUTO" | "PROVISIONAL",
  ): Promise<boolean> {
    const saved = await ChatRepo.saveGeneratedTitle(consultationId, title, source);
    if (!saved) return false;
    // Pushed the moment it's saved (title generation usually finishes in 1-2s, well before the
    // reply itself) rather than waiting for the frontend's end-of-turn refetch, so the sidebar/
    // header title updates immediately instead of trailing behind the topic breakdown, which
    // only becomes available once the full reply is persisted.
    emitToUser(userId, "chat:title-updated", { consultationId, title });
    return true;
  }

  /**
   * Smart re-titling: on each substantive new message in an AI-titled consultation, asks the
   * model whether the title still fits the conversation (usually KEEP) or should become a
   * sharper/new one. Runs alongside the reply like the first title pass. Never throws, never
   * touches a user-set title (saveGeneratedTitle is conditional).
   */
  private static async refreshTitle(p: {
    consultationId: string;
    tenantCode: TenantCode;
    userId: string;
    currentTitle: string;
    attachmentNames: string[];
  }): Promise<void> {
    try {
      // Includes the new message: it's saved before generation starts.
      const userMessages = await ChatRepo.listRecentUserMessageContents(p.consultationId, RETITLE_MESSAGE_WINDOW);
      if (userMessages.length === 0) return;
      const raw = await generateTitleViaWs(
        buildChatRetitlePrompt({
          jurisdiction: p.tenantCode === "UK" ? "UK" : "Philippine",
          currentTitle: p.currentTitle,
          userMessages,
          attachmentNames: p.attachmentNames,
        }),
      );
      const title = raw ? ChatSvc.parseTitle(raw) : "";
      if (!title || title.toUpperCase().includes(KEEP_TITLE_SENTINEL) || ChatSvc.isUnclearTitle(title)) return;
      if (!ChatSvc.isValidTitle(title) || title.toLowerCase() === p.currentTitle.trim().toLowerCase()) return;
      const saved = await ChatSvc.saveTitle(p.consultationId, p.userId, title, "AUTO");
      if (saved) logger.info("Chat title: refreshed", { consultationId: p.consultationId, from: p.currentTitle, to: title });
    } catch (err) {
      logger.warn("Chat title: refresh failed (non-fatal, title unchanged)", { consultationId: p.consultationId, err });
    }
  }

  /**
   * Second title pass, once the reply is saved: a vague first message ("what are these
   * documents?", a bare file upload) is usually only titleable from what the answer says about
   * it. Runs only if pass 1 didn't save a title. If the model still gives nothing usable — an
   * outage, error text, off-format — falls back to a title built from the file names or the
   * message itself; only a deliberate "nothing coherent here" (gibberish) stays untitled.
   * Never throws: a title problem must not surface as a failed turn.
   */
  private static async titleAfterReply(p: {
    consultationId: string;
    tenantCode: TenantCode;
    userId: string;
    userInput: string;
    typedInput: string;
    attachmentNames: string[];
    fullResponse: string;
    firstPass: Promise<TitleOutcome>;
  }): Promise<void> {
    try {
      const first = await p.firstPass;
      if (first === "saved") return;
      // A greeting has nothing more to title after the reply either (the reply is a greeting
      // back) — skip the second call and hold a neutral placeholder until a real question.
      if (first === "smalltalk") {
        await ChatSvc.saveProvisionalIfUntitled(p.consultationId, p.userId, PROVISIONAL_GREETING_TITLE);
        return;
      }
      // Pass 1 may have lost a race with a rename, or saved via another instance. A provisional
      // title doesn't count — this pass exists to replace it.
      const current = await ChatRepo.findConsultationTitleState(p.consultationId);
      if (current?.title && current.titleSource !== "PROVISIONAL") return;

      const replyExcerpt = stripStructuredBlocks(p.fullResponse);
      const second = await ChatSvc.generateAndSaveTitle(p.consultationId, p.userInput, p.tenantCode, p.userId, {
        attachmentNames: p.attachmentNames,
        replyExcerpt,
      }).catch(() => "failed" as const);
      if (second === "saved") return;
      if (second === "smalltalk") {
        await ChatSvc.saveProvisionalIfUntitled(p.consultationId, p.userId, PROVISIONAL_GREETING_TITLE);
        return;
      }

      const fallback = second === "failed" ? fallbackTitle(p.typedInput, p.attachmentNames) : null;
      if (!fallback) {
        // Nothing coherent to title (gibberish): a provisional title beats "Untitled
        // consultation", and the next real message replaces it (needsTitle in the send path).
        await ChatSvc.saveProvisionalIfUntitled(p.consultationId, p.userId, PROVISIONAL_UNCLEAR_TITLE);
        return;
      }
      await ChatSvc.saveTitle(p.consultationId, p.userId, fallback, "AUTO");
      logger.info("Chat title: saved fallback title (model unavailable)", {
        consultationId: p.consultationId,
        title: fallback,
      });
    } catch (err) {
      logger.error("Chat title: post-reply pass failed (non-fatal)", { consultationId: p.consultationId, err });
    }
  }
}

type TitleOutcome = "saved" | "unclear" | "smalltalk" | "failed";

/** How many recent user messages the re-title prompt sees — enough for the thread's direction. */
const RETITLE_MESSAGE_WINDOW = 6;

/** A message worth re-checking the title for: two or more real words ("thanks" / "ok" / "asdf"
 * never change what a consultation is about, so they don't cost a model call). */
function isSubstantive(text: string): boolean {
  return (text.match(/\p{L}{2,}/gu) ?? []).length >= 2;
}

/** Last resort when the title model is unavailable: "Document Review: <first file>" for an
 * upload, otherwise the start of the message itself. Null when there's nothing wordlike to use. */
function fallbackTitle(typedInput: string, attachmentNames: string[]): string | null {
  const clip = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= TITLE_MAX_CHARS) return clean;
    const cut = clean.slice(0, TITLE_MAX_CHARS - 1);
    return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length)}…`;
  };
  // With files attached the message is usually the vague part ("what are these?") — the file
  // name says more about the matter.
  const file = attachmentNames[0]?.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
  if (file) return clip(`Document Review: ${file}`);
  const text = typedInput.trim().replace(/[?.!]+$/, "");
  // Two or more letter-words: a real phrase, not "asdf" or a lone emoji.
  if ((text.match(/\p{L}{2,}/gu) ?? []).length >= 2) {
    return clip(text.charAt(0).toUpperCase() + text.slice(1));
  }
  return null;
}

