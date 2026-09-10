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
import { extractTimeline, extractMindMap, stripStructuredBlocks, splitIntoTopics, MindMapItem, TimelineItem, AudioOverviewTurn, ReasoningExplanation } from "../utils/response-parser";
import CaseTimelineSvc from "./case-timeline.service";
import { documentBelongsToScope } from "../utils/case-document-scope";
import { getChatTitlePromptBuilder } from "../legal/prompt-registry";
import { TenantCode } from "../types/tenant-code";
import { voicePairForCase } from "../utils/audio-overview-voices";
import AudioOverviewQueue from "../queues/audio-overview.queue";
import MessagePersistenceQueue, { AssistantTurnPayload } from "../queues/message-persistence.queue";
import { getPresignedGetUrl } from "../utils/s3";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import { TITLE_CACHE_TTL, RESPONSE_CACHE_TTL, TITLE_MAX_CHARS, CHAT_WONDER_SESSION_TTL_S, ATTACHMENT_ONLY_PROMPT } from "../constants";
import { chatWonderSessionKey, titleCacheKey, responseCacheKey, groundingCacheKey } from "../utils/chat.utils";

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

  static async sendMessage(
    organizationId: string,
    tenantCode: TenantCode,
    userId: string,
    consultationId: string,
    requestedSessionId: string,
    userInput: string,
    onChunk: (text: string) => void,
    documentContext?: string,
    onSessionRotated?: (newSessionId: string) => void,
    caseDocumentId?: string,
    caseId?: string,
    documentIds?: string[],
  ) {
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
    if (sessionId !== requestedSessionId) {
      onSessionRotated?.(sessionId);
    }

    const needsTitle = consultation.title === null;
    const userMessage = await ChatRepo.createMessage(consultationId, "user", userInput, userId);

    if (documentIds?.length) {
      await DocumentRepo.linkToMessage(documentIds, userMessage.id, organizationId, consultationId);
    }

    // content stays a stored empty string for a file-only send (see ADR) — everything the AI
    // and title generation actually see substitutes in a fixed stand-in instead.
    const effectiveUserInput = userInput.trim() ? userInput : ATTACHMENT_ONLY_PROMPT;

    if (needsTitle) {
      ChatSvc.generateAndSaveTitle(consultationId, effectiveUserInput, tenantCode).catch(() => {});
    }

    // Re-derived from the live Case row on every message (not cached on the consultation),
    // so edits to the Case's fields are picked up immediately rather than going stale.
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
    if (scopedDocumentId) {
      grounding = await DocumentChunkSvc.relevantChunksForDocument(scopedDocumentId, userInput);
      if (!grounding.caseDocumentIds.length) grounding = undefined;
    } else {
      const consultationDocs = await DocumentChunkSvc.relevantChunksForConsultation(
        consultationId,
        userInput,
      );
      if (consultationDocs.caseDocumentIds.length) {
        grounding = consultationDocs;
      } else if (effectiveCaseId) {
        grounding = await DocumentChunkSvc.relevantChunksForCase(effectiveCaseId, userInput);
        if (!grounding.caseDocumentIds.length) grounding = undefined;
      }
    }

    // Inline ranked chunk text into document_context. Chat-wonder also receives case_document_ids
    // for its callback fetch, but that often fails in local/staging (ILOVELAWYER_API_BASE points
    // at production with a mismatched API key) — inlining keeps analysis working either way.
    const groundingContext = grounding
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
      userInput,
    );
    let transcriptGrounding = consultationTranscripts.transcriptionIds.length
      ? consultationTranscripts
      : effectiveCaseId
        ? await TranscriptionChunkSvc.relevantChunksForCase(effectiveCaseId, userInput)
        : undefined;
    if (transcriptGrounding && !transcriptGrounding.transcriptionIds.length) transcriptGrounding = undefined;
    const transcriptContext = transcriptGrounding
      ? await TranscriptionChunkSvc.formatGroundingContext(transcriptGrounding)
      : "";

    const resolvedContext = [caseContext, documentContext, groundingContext, transcriptContext]
      .filter(Boolean)
      .join("\n\n");

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

    let fullResponse: string;
    let relatedCases: RelatedCase[];
    let streamedMindMap: MindMapItem | undefined;
    let streamedTimeline: TimelineItem[] | undefined;
    let streamedAudioOverview: AudioOverviewTurn[] | undefined;
    let streamedReasoning: ReasoningExplanation | undefined;
    if (useCache && cached) {
      onChunk(cached.content);
      fullResponse = cached.content;
      relatedCases = cached.relatedCases;
      streamedMindMap = cached.mindMap;
      streamedTimeline = cached.timeline;
      streamedAudioOverview = cached.audioOverview;
      streamedReasoning = cached.reasoning;
    } else {
      // Guards against a duplicate mind-map/audio-overview generation if a page refresh mid-
      // stream makes the CTA look idle again (see AiGenerationJob) — ordinary chat turns are
      // untouched, since there's no "duplicate generate" concern for two different questions.
      const generationKind = wantsMindMap ? "mindMap" : wantsAudioOverview ? "audioOverviewScript" : null;
      const runStream = () =>
        ChatSvc.streamWithSessionRetry(
          consultationId,
          sessionId,
          userInput,
          onChunk,
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
      fullResponse = result.content;
      relatedCases = result.relatedCases;
      streamedMindMap = result.mindMap;
      streamedTimeline = result.timeline;
      streamedAudioOverview = result.audioOverview;
      streamedReasoning = result.reasoning;
      redis.set(
        cacheKey,
        {
          content: fullResponse,
          relatedCases,
          mindMap: streamedMindMap,
          timeline: streamedTimeline,
          audioOverview: streamedAudioOverview,
          reasoning: streamedReasoning,
        },
        RESPONSE_CACHE_TTL,
      );
    }

    // The reply has fully streamed to the client by this point. Persisting it (topic split,
    // MessageGroup, timeline/mind-map/audio-overview/reasoning/related-cases) is handed to
    // MessagePersistenceQueue so ChatCtrl's res.end() fires on the last token instead of
    // after every write. An enqueue-send failure falls back to persisting in-process (see the
    // queue's memoryWait path), so a turn is never dropped.
    MessagePersistenceQueue.enqueue({
      consultationId,
      parentMessageId: userMessage.id,
      effectiveCaseId: effectiveCaseId ?? null,
      userId,
      fullResponse,
      relatedCases,
      mindMap: streamedMindMap,
      timeline: streamedTimeline,
      audioOverview: streamedAudioOverview,
      reasoning: streamedReasoning,
    });
  }

  /**
   * Persists a chat turn's assistant reply after it has already streamed to the client —
   * lifted out of sendMessage and run from MessagePersistenceQueue. A failure in any single
   * write here can no longer take an already-delivered response down with it (it's off the
   * request entirely now), but the same per-write .catch guards are kept so one bad write
   * doesn't abort the rest.
   *
   * Idempotent: the queue's SQS message redelivers if a worker crashed after saving but
   * before acking, and a split reply (several sibling rows) must not be persisted twice.
   */
  static async persistAssistantTurn(p: AssistantTurnPayload): Promise<void> {
    if (await ChatRepo.findAssistantReplyByParent(p.parentMessageId)) {
      logger.info("Message persistence: assistant turn already persisted, skipping", {
        parentMessageId: p.parentMessageId,
      });
      return;
    }

    // audioOverview/reasoning have no text-fallback re-parse (unlike timeline/mindMap) — they
    // only ever arrive as Chat Wonder's own dedicated frames, never inline in fullResponse.
    const timeline = p.timeline ?? extractTimeline(p.fullResponse);
    const mindMap = p.mindMap ?? extractMindMap(p.fullResponse);
    const audioOverview = p.audioOverview;
    const reasoning = p.reasoning;
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

    if (timeline) await ChatRepo.saveTimeline(assistantMessage.id, timeline);
    if (timeline && p.effectiveCaseId) {
      await CaseTimelineSvc.promoteFromAi(p.effectiveCaseId, timeline, p.userId).catch(() => {});
    }
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
    if (p.relatedCases.length) await ChatRepo.saveRelatedCases(assistantMessage.id, p.relatedCases);
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

  /** Ignore a client-supplied document id unless it belongs to this consultation or case. */
  private static async scopedCaseDocumentId(
    caseDocumentId: string | undefined,
    userId: string,
    consultationId: string,
    caseId?: string,
  ): Promise<string | undefined> {
    if (!caseDocumentId) return undefined;
    const doc = await DocumentRepo.findById(caseDocumentId, userId);
    if (!doc) return undefined;
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

  private static async generateAndSaveTitle(
    consultationId: string,
    userMessage: string,
    tenantCode: TenantCode,
  ): Promise<void> {
    const cacheKey = titleCacheKey(userMessage, tenantCode);

    let title = await redis.get<string>(cacheKey);

    if (!title) {
      const raw = await generateTitleViaWs(ChatSvc.buildTitlePrompt(userMessage, tenantCode));
      if (!raw) return;
      title = ChatSvc.parseTitle(raw);
      if (!title) return;
      redis.set(cacheKey, title, TITLE_CACHE_TTL);
    }

    await ChatRepo.updateConsultation(consultationId, title);
  }
}
