import ChatRepo from "../repositories/chat.repository";
import AuthRepo from "../repositories/auth.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CaseSvc from "./case.service";
import DocumentChunkSvc from "./document-chunk.service";
import TranscriptionChunkSvc from "./transcription-chunk.service";
import { mapDocumentToDto } from "./document.service";
import { enrichRelatedCaseTitles } from "../utils/related-case-titles";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, GenerationCancelledError, RelatedCase, CaseDocumentGrounding } from "../utils/chatWonder";
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
import { TenantCode } from "../types/tenant-code";
import { voicePairForCase } from "../utils/audio-overview-voices";
import AudioOverviewQueue from "../queues/audio-overview.queue";
import CaseGraphPromotionQueue, { CaseGraphPromotionPayload } from "../queues/case-graph-promotion.queue";
import GroundingVerifierSvc from "./grounding-verifier.service";
import { triageMessage, triageContextFor, notificationFor, resolveReplyLanguage, MessageTriage, ATTACHMENT_THRESHOLD } from "../utils/message-triage";
import NotificationSvc from "./notification.service";
import ParticipantRepo from "../repositories/participant.repository";
import ChatGenerationQueue, { ChatGenerationJob } from "../queues/chat-generation.queue";
import { getProxyFileUrl } from "../utils/s3";
import CaseMindMapSvc from "./case-mind-map.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import DecisionRecordRepo from "../repositories/decision-record.repository";
import { emitToUser } from "../lib/socket";
import { TITLE_CACHE_TTL, RESPONSE_CACHE_TTL, TITLE_MAX_CHARS, CHAT_WONDER_SESSION_TTL_S, ATTACHMENT_ONLY_PROMPT, UNCLEAR_TITLE_SENTINEL } from "../constants";
import { chatWonderSessionKey, titleCacheKey, responseCacheKey, groundingCacheKey } from "../utils/chat.utils";
import { resolveRelatedCaseLibraryLinks, rewriteLegalCitationLinks } from "../utils/legal-citation-link-rewrite";

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
    }
    return ChatRepo.createConsultation(organizationId, userId, title, caseId);
  }

  static async listConsultations(organizationId: string, caseId?: string) {
    return ChatRepo.listConsultations(organizationId, caseId);
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

  static async renameConsultation(organizationId: string, consultationId: string, title: string) {
    await this.assertConsultationOwned(organizationId, consultationId);
    return ChatRepo.updateConsultation(consultationId, title);
  }

  static async assertConsultationOwned(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    return consultation;
  }

  static async deleteConsultation(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    return ChatRepo.deleteConsultation(consultationId);
  }

  static async listMessages(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

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
          const url = getProxyFileUrl(file.s3Key, { filename: file.filename ?? undefined });
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
    return ChatRepo.deleteMessage(messageId);
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

    const needsTitle = consultation.title === null;

    // content stays a stored empty string for a file-only send (see ADR) — everything the AI
    // and title generation actually see substitutes in a fixed stand-in instead.
    const effectiveUserInput = userInput.trim() ? userInput : ATTACHMENT_ONLY_PROMPT;

    if (needsTitle) {
      const titleStartedAt = Date.now();
      ChatSvc.generateAndSaveTitle(consultationId, effectiveUserInput, tenantCode, userId).catch((err) => {
        logger.error("Chat title: generation failed (non-fatal — reply unaffected, retries next message)", {
          consultationId,
          tenantCode,
          err,
          elapsedMs: Date.now() - titleStartedAt,
        });
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
            { mindMapRequested: wantsMindMap, mindMapContext: mindMapContext || undefined },
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
      await ChatRepo.saveAudioOverview(assistantMessage.id, audioOverview, hostA, hostB).catch((err) => {
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
   * Case-graph enrichment for an already-persisted chat turn: promotes the AI's timeline into
   * the case's own Timeline table (CaseTimelineSvc.promoteFromAi) and its decision records into
   * the case's DecisionRecord table + CaseGraph nodes/edges (DecisionRecordSvc.promote). Called
   * from CaseGraphPromotionQueue, after ChatSvc.persistAssistantTurn has already durably created
   * the assistant Message this enriches — this step is a nice-to-have on top of an already-
   * complete, already-visible reply, never a prerequisite for it.
   *
   * Idempotent: CaseTimelineSvc.promoteFromAi already dedupes by title+date against existing
   * rows. DecisionRecordSvc.promote does not dedupe on its own (each call is meant to add new
   * records), so a guard here checks for records already promoted from this assistantMessageId
   * before calling it — needed now that SQS redelivery of this job is the only thing that would
   * otherwise call promote() twice for the same turn.
   */
  static async promoteAssistantTurnToCaseGraph(p: CaseGraphPromotionPayload): Promise<void> {
    if (!p.effectiveCaseId) return;

    if (p.timeline?.length) {
      await CaseTimelineSvc.promoteFromAi(p.effectiveCaseId, p.timeline, p.userId).catch((err) => {
        logger.error("Case graph promotion: failed to promote timeline", {
          err,
          caseId: p.effectiveCaseId,
          assistantMessageId: p.assistantMessageId,
        });
      });
    }

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
    mindMap?: { mindMapRequested: boolean; mindMapContext?: string },
  ) {
    const opts = mindMap?.mindMapRequested ? mindMap : undefined;
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode, signal, onAnswerComplete, replyLanguage, opts);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode, signal, onAnswerComplete, replyLanguage, opts);
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

    await ChatRepo.updateAudioOverviewAudio(messageId, { audioStatus: "IN_PROGRESS" });
    AudioOverviewQueue.enqueue(messageId);
    return { status: "IN_PROGRESS" as const };
  }

  static async pollAudioOverviewAudio(organizationId: string, consultationId: string, messageId: string) {
    await ChatSvc.assertConsultationOwned(organizationId, consultationId);
    const row = await ChatRepo.findAudioOverviewByMessageId(messageId);
    if (!row) throw new HttpError("No Audio Overview script for this message", 404);

    if (row.audioStatus === "COMPLETED" && row.audioFile?.s3Key) {
      return {
        status: "COMPLETED" as const,
        audioFile: { id: row.audioFile.id, fileUrl: getProxyFileUrl(row.audioFile.s3Key) },
      };
    }
    if (row.audioStatus === "FAILED") return { status: "FAILED" as const };
    return { status: "IN_PROGRESS" as const };
  }

  /** tenantCode defaults to PH to preserve scripts/backfill-titles.ts's existing single-arg
   * call signature — callers that know the tenant's actual tenantCode (generateAndSaveTitle
   * below) must pass it explicitly. */
  static buildTitlePrompt(userMessage: string, tenantCode: TenantCode = "PH"): string {
    return getChatTitlePromptBuilder(tenantCode)(userMessage);
  }

  static parseTitle(raw: string): string {
    return raw
      .split("\n")[0]
      .replace(/^["'""'']|["'""'']$/g, "")
      .replace(/\.$/, "")
      .trim()
      .slice(0, TITLE_MAX_CHARS);
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

  private static async generateAndSaveTitle(
    consultationId: string,
    userMessage: string,
    tenantCode: TenantCode,
    userId: string,
  ): Promise<void> {
    const cacheKey = titleCacheKey(userMessage, tenantCode);
    const startedAt = Date.now();

    let title = await redis.get<string>(cacheKey);
    // Titles cached before isValidTitle existed may be error text — regenerate instead.
    if (title && !ChatSvc.isValidTitle(title)) title = null;

    if (title) {
      logger.info("Chat title: cache hit", { consultationId, tenantCode });
    } else {
      const raw = await generateTitleViaWs(ChatSvc.buildTitlePrompt(userMessage, tenantCode));
      if (!raw) {
        logger.info("Chat title: model returned no content, leaving untitled (retries next message)", {
          consultationId,
          tenantCode,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      title = ChatSvc.parseTitle(raw);
      // Left untitled rather than saved — gibberish/unclear input stays untitled (frontend
      // falls back to "Untitled consultation") instead of a fabricated legal category, and
      // since consultation.title stays null, the next message's send retries generation with
      // whatever the user says next.
      if (!title || ChatSvc.isUnclearTitle(title)) {
        logger.info(
          !title
            ? "Chat title: parsed title was empty, leaving untitled"
            : "Chat title: model returned UNCLEAR_INPUT sentinel (working as intended), leaving untitled",
          { consultationId, tenantCode, raw: raw.slice(0, 120) },
        );
        return;
      }
      if (!ChatSvc.isValidTitle(title)) {
        logger.warn("Chat title: model reply wasn't a valid title (error text or off-format), leaving untitled", {
          consultationId,
          tenantCode,
          raw: raw.slice(0, 120),
        });
        return;
      }
      redis.set(cacheKey, title, TITLE_CACHE_TTL);
    }

    await ChatRepo.updateConsultation(consultationId, title);
    logger.info("Chat title: saved", { consultationId, tenantCode, title, elapsedMs: Date.now() - startedAt });
    // Pushed the moment it's saved (title generation usually finishes in 1-2s, well before the
    // reply itself) rather than waiting for the frontend's end-of-turn refetch, so the sidebar/
    // header title updates immediately instead of trailing behind the topic breakdown, which
    // only becomes available once the full reply is persisted.
    emitToUser(userId, "chat:title-updated", { consultationId, title });
  }
}
