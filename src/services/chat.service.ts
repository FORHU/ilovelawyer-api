import ChatRepo from "../repositories/chat.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseSvc from "./case.service";
import DocumentChunkSvc from "./document-chunk.service";
import TranscriptionChunkSvc from "./transcription-chunk.service";
import { mapDocumentToDto } from "./document.service";
import { generateTitleViaWs, streamChatWonderMessage, getChatWonderSessionId, RelatedCase, CaseDocumentGrounding } from "../utils/chatWonder";
import { redis } from "../lib/redis";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { extractTimeline, extractMindMap, stripStructuredBlocks, splitIntoTopics, MindMapItem, TimelineItem, AudioOverviewTurn, ReasoningExplanation, DecisionRecordsPayload, TraceStep } from "../utils/response-parser";
import DecisionRecordSvc from "./decision-record.service";
import CaseTimelineSvc from "./case-timeline.service";
import { documentBelongsToScope } from "../utils/case-document-scope";
import { getChatTitlePromptBuilder } from "../legal/prompt-registry";
import { TenantCode } from "../types/tenant-code";
import { voicePairForCase } from "../utils/audio-overview-voices";
import AudioOverviewQueue from "../queues/audio-overview.queue";
import CaseGraphPromotionQueue, { CaseGraphPromotionPayload } from "../queues/case-graph-promotion.queue";
import ChatGenerationQueue, { ChatGenerationJob } from "../queues/chat-generation.queue";
import { getPresignedGetUrl } from "../utils/s3";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import DecisionRecordRepo from "../repositories/decision-record.repository";
import { emitToUser } from "../lib/socket";
import { TITLE_CACHE_TTL, RESPONSE_CACHE_TTL, TITLE_MAX_CHARS, CHAT_WONDER_SESSION_TTL_S, ATTACHMENT_ONLY_PROMPT, UNCLEAR_TITLE_SENTINEL } from "../constants";
import { chatWonderSessionKey, titleCacheKey, responseCacheKey, groundingCacheKey } from "../utils/chat.utils";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded exponential backoff for the request-path canonical-persistence retry — 2s, 4s, 8s.
// Long enough to ride out a transient RDS blip, bounded enough not to hang the HTTP request
// indefinitely if the DB is genuinely down (worst case adds ~14s before the request fails).
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
  /** Raw accumulated reply text — persistAssistantTurn still needs the un-stripped form for
   * stripStructuredBlocks / splitIntoTopics / the extractTimeline+extractMindMap fallback. */
  fullResponse: string;
  relatedCases: RelatedCase[];
  mindMap?: MindMapItem;
  timeline?: TimelineItem[];
  audioOverview?: AudioOverviewTurn[];
  reasoning?: ReasoningExplanation;
  decisions?: DecisionRecordsPayload;
  researchSteps?: TraceStep[];
}

export default class ChatSvc {
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
    return Promise.all(
      messages.map(async (m) => ({ ...m, documents: await Promise.all(m.documents.map(mapDocumentToDto)) })),
    );
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
    const t0 = Date.now();
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

    // Grounding priority:
    // 1. Explicit caseDocumentId on this message (single-doc ranking) — only if it belongs
    //    to this consultation or case. A client-supplied id from another case must not rank.
    // 2. READY docs attached to this consultation (consultation-specific data source)
    // 3. Case id (consultation or message body) → rank READY docs under that case
    let grounding: CaseDocumentGrounding | undefined;
    const scopedDocumentId = await ChatSvc.scopedCaseDocumentId(
      caseDocumentId,
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

    const resolvedContext = [caseContext, documentContext, groundingContext, transcriptContext]
      .filter(Boolean)
      .join("\n\n");
    logger.info("Chat: grounding/RAG context resolved", {
      consultationId,
      messageId: parentMessageId,
      caseDocumentChunks: grounding?.caseDocumentIds.length ?? 0,
      transcriptChunks: transcriptGrounding?.transcriptionIds.length ?? 0,
      contextChars: resolvedContext.length,
      elapsedMs: Date.now() - t0,
    });

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
    const checkpointedOnChunk = (text: string) => {
      // Best-effort live push for a browser actively connected right now — emitToUser is a
      // no-op if nobody's listening (tab refreshed/closed, or never had a socket). This is
      // purely a UX nicety on top of the durable checkpoint above, never load-bearing for
      // correctness: a disconnected/refreshed client falls back to the messages API and
      // reading pendingReplyContent, same as it always could.
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
    let streamedAudioOverview: AudioOverviewTurn[] | undefined;
    let streamedReasoning: ReasoningExplanation | undefined;
    let streamedDecisions: DecisionRecordsPayload | undefined;
    let streamedResearchSteps: TraceStep[] | undefined;
    try {
      if (useCache && cached) {
        checkpointedOnChunk(cached.content);
        fullResponse = cached.content;
        relatedCases = cached.relatedCases;
        streamedMindMap = cached.mindMap;
        streamedTimeline = cached.timeline;
        streamedAudioOverview = cached.audioOverview;
        streamedReasoning = cached.reasoning;
        streamedDecisions = cached.decisions;
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
        fullResponse = result.content;
        relatedCases = result.relatedCases;
        streamedMindMap = result.mindMap;
        streamedTimeline = result.timeline;
        streamedAudioOverview = result.audioOverview;
        streamedReasoning = result.reasoning;
        streamedDecisions = result.decisions;
        streamedResearchSteps = result.researchSteps;
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
            researchSteps: streamedResearchSteps,
          },
          RESPONSE_CACHE_TTL,
        );
      }
    } catch (err) {
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
    const assistantTurnPayload: AssistantTurnPayload = {
      consultationId,
      parentMessageId,
      effectiveCaseId: effectiveCaseId ?? null,
      userId,
      fullResponse,
      relatedCases,
      mindMap: streamedMindMap,
      timeline: streamedTimeline,
      audioOverview: streamedAudioOverview,
      reasoning: streamedReasoning,
      decisions: streamedDecisions,
      researchSteps: streamedResearchSteps,
    };

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
    const cleanedContent = stripStructuredBlocks(p.fullResponse);
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
  ) {
    try {
      return await streamChatWonderMessage(sessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("Unknown session")) throw err;
      const freshSessionId = await ChatSvc.storeChatWonderSession(consultationId, await getChatWonderSessionId());
      // Report the rotation before streaming starts, so the caller (ChatCtrl) can still
      // set a response header — nothing has been written to the HTTP response yet at
      // this point, since "Unknown session." always arrives before any real content.
      onSessionRotated?.(freshSessionId);
      return streamChatWonderMessage(freshSessionId, userInput, onChunk, resolvedContext, grounding, caseId, tenantCode);
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
    userId: string,
    consultationId: string,
    caseId?: string,
  ): Promise<string | undefined> {
    if (!caseDocumentId) return undefined;
    const doc = await DocumentRepo.findById(caseDocumentId, userId);
    if (!doc) return undefined;
    if (doc.status === "ARCHIVED") return undefined;
    if (!documentBelongsToScope(doc, { userId, consultationId, caseId })) return undefined;
    return doc.id;
  }

  static async getRelatedCases(organizationId: string, consultationId: string) {
    const consultation = await ChatRepo.findConsultationById(consultationId);
    if (!consultation || consultation.organizationId !== organizationId) {
      throw new HttpError("Consultation not found", 404);
    }

    const message = await ChatRepo.findLatestAssistantMessage(consultationId);
    return message?.relatedCases?.items ?? [];
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
        audioFile: { id: row.audioFile.id, fileUrl: await getPresignedGetUrl(row.audioFile.s3Key) },
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

  private static async generateAndSaveTitle(
    consultationId: string,
    userMessage: string,
    tenantCode: TenantCode,
    userId: string,
  ): Promise<void> {
    const cacheKey = titleCacheKey(userMessage, tenantCode);
    const startedAt = Date.now();

    let title = await redis.get<string>(cacheKey);

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
