import type { ClientWorkspace } from "./client-case.service";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import DocumentRepo from "../repositories/document.repository";
import ClientIntakeSvc from "./client-intake.service";
import IntakeChatGenerationQueue, { IntakeChatGenerationJob } from "../queues/intake-chat-generation.queue";
import { streamIntakeChatWonderMessage, getChatWonderSessionIdForIntake, IntakeGenerationCancelledError } from "../utils/intakeChatWonder";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import { excerptsWithHandles } from "../utils/case-document-handles";
import { redis } from "../lib/redis";
import { emitToUser } from "../lib/socket";
import { runInLlmUsageScope } from "../lib/llm-usage-scope";
import ConsentSvc from "./consent.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { stripStructuredBlocks } from "../utils/response-parser";
import { redactDocumentIds } from "../utils/document-references";

/** How a running intake turn is stopped — same shape as ChatSvc's GenerationControl, its own
 * copy (see intake-field-crypto.ts's doc comment on why duplication here is deliberate). */
interface IntakeGenerationControl {
  abort: AbortController;
  getPartial: () => string;
}

const CANCEL_POLL_INTERVAL_MS = 1_000;
const CHAT_WONDER_SESSION_TTL_S = 60 * 60 * 24; // 1 day, same as the lawyer/client pipeline's session TTL
const MAX_DOCUMENT_EXCERPT_CHARS = 12_000;

function intakeSessionKey(caseId: string): string {
  // A distinct key prefix from chatWonderSessionKey's "chatwonder:session:<consultationId>" —
  // the intake pipeline's own session cache namespace, never colliding with the lawyer/client one.
  return `chatwonder:session:intake:${caseId}`;
}

/**
 * The intake chat pipeline's own turn-lifecycle processor — a fully separate implementation from
 * ChatSvc.runChatGenerationJob/processChatGenerationJob, scoped to what intake actually needs
 * (see the 2026-10-28 intake-pipeline design doc's scoping table). Deliberately missing, by
 * design, not oversight: title generation (one thread per case, no title concept), Jev message
 * triage (lawyer-Terminal-specific; intake has its own live classification via
 * assessLawyerReadiness, unchanged), trial-guest recap (a lawyer-Terminal-only concept), and the
 * full embedding-chunk RAG chain (DocumentChunkSvc) — intake's document grounding is a lighter
 * excerpt pack, the same one ClientIntakeSvc already builds its overview from.
 */
export default class IntakeChatSvc {
  private static activeGenerations = new Map<string, IntakeGenerationControl>();

  /** The chat, oldest first. `replying` mirrors ClientCaseSvc.listMessages' existing shape so the
   * frontend's polling/typing-indicator logic needs no change once repointed. */
  static async listMessages(_workspace: ClientWorkspace, _userId: string, caseId: string) {
    const messages = await IntakeChatRepo.listByCase(caseId);
    const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
    return {
      replying: visible.some((m) => m.role === "user" && m.replyStatus === "PENDING"),
      messages: visible.map((m) => ({
        id: m.id,
        role: m.role === "user" ? ("user" as const) : ("ai" as const),
        text: m.content,
        replyStatus: m.role === "user" ? m.replyStatus : null,
        // Document names/status aren't resolved inline here (IntakeMessage carries only ids, no
        // relation like Message.documents) — the frontend already has a document-list endpoint
        // for a case; resolve names there rather than duplicating that join on every message read.
        documentIds: m.role === "user" ? m.documentIds : [],
        createdAt: m.createdAt,
      })),
    };
  }

  /** Enqueues a turn on the intake pipeline's own queue. Credit spend/refund and attachment
   * ownership checks stay in ClientCaseSvc.sendMessage (the caller) — this only owns the
   * generation job itself, same split of responsibility ChatSvc.enqueueChatGeneration had. */
  static async enqueueIntakeGeneration(
    workspace: ClientWorkspace,
    userId: string,
    caseId: string,
    text: string,
    documentIds?: string[],
  ): Promise<{ messageId: string; sessionId: string; replyStatus: "PENDING" }> {
    if (await IntakeChatRepo.hasPendingTurn(caseId)) {
      throw new HttpError("A reply is already generating for this case", 409);
    }
    const sessionId = await IntakeChatSvc.resolveSession(caseId);
    const userMessage = await IntakeChatRepo.createMessage(caseId, "user", text, userId, documentIds, "PENDING");

    const job: IntakeChatGenerationJob = {
      jobId: userMessage.id,
      tenantCode: workspace.tenantCode,
      userId,
      caseId,
      sessionId,
      userInput: text,
      documentIds,
    };
    IntakeChatGenerationQueue.enqueue(job);
    return { messageId: userMessage.id, sessionId, replyStatus: "PENDING" };
  }

  private static async resolveSession(caseId: string): Promise<string> {
    const stored = await redis.get<string>(intakeSessionKey(caseId));
    if (typeof stored === "string" && stored.length > 0) {
      await redis.set(intakeSessionKey(caseId), stored, CHAT_WONDER_SESSION_TTL_S);
      return stored;
    }
    const fresh = await getChatWonderSessionIdForIntake();
    await redis.set(intakeSessionKey(caseId), fresh, CHAT_WONDER_SESSION_TTL_S);
    return fresh;
  }

  /** Stops an in-flight intake turn — same idiom as ChatSvc.cancelChatGeneration. */
  static async cancelIntakeGeneration(
    _workspace: ClientWorkspace,
    requesterUserId: string,
    caseId: string,
    messageId: string,
  ): Promise<{ messageId: string; replyStatus: string | null; assistantMessageId?: string }> {
    const message = await IntakeChatRepo.findReplyState(messageId);
    if (!message || message.caseId !== caseId || message.role !== "user") {
      throw new HttpError("Message not found", 404);
    }

    const cancelled = await IntakeChatRepo.markReplyCancelled(messageId, caseId);
    if (!cancelled) {
      const current = await IntakeChatRepo.findReplyState(messageId);
      return { messageId, replyStatus: current?.replyStatus ?? null };
    }

    const running = IntakeChatSvc.activeGenerations.get(messageId);
    const partialRaw = running ? running.getPartial() : (message.pendingReplyContent ?? "");
    running?.abort.abort();

    const partial = stripStructuredBlocks(partialRaw);
    let assistantMessageId: string | undefined;
    if (partial) {
      const existing = await IntakeChatRepo.findAssistantReplyByParent(messageId);
      assistantMessageId = existing?.id ?? (await IntakeChatRepo.createMessage(caseId, "assistant", partial, undefined, undefined, undefined, messageId)).id;
    }

    for (const uid of new Set([message.userId, requesterUserId].filter((id): id is string => Boolean(id)))) {
      try {
        emitToUser(uid, "chat:cancelled", { caseId, messageId, assistantMessageId });
      } catch (err) {
        logger.warn("Intake chat generation: emitToUser(chat:cancelled) failed", { err, messageId });
      }
    }
    return { messageId, replyStatus: "CANCELLED", assistantMessageId };
  }

  static async processIntakeGenerationJob(job: IntakeChatGenerationJob): Promise<void> {
    if (!(await ConsentSvc.isAllowed(job.userId, "AI_PROCESSING"))) {
      logger.info("Intake chat generation: skipped, AI processing consent is withdrawn", { jobId: job.jobId, caseId: job.caseId });
      await IntakeChatRepo.setReplyStatus(job.jobId, "FAILED").catch(() => {});
      try {
        emitToUser(job.userId, "chat:error", { caseId: job.caseId, messageId: job.jobId, message: "AI processing is switched off for your account." });
      } catch (err) {
        logger.warn("Intake chat generation: emitToUser failed, continuing without it", { err, jobId: job.jobId });
      }
      return;
    }

    const control: IntakeGenerationControl = { abort: new AbortController(), getPartial: () => "" };
    IntakeChatSvc.activeGenerations.set(job.jobId, control);
    const cancelPoll = setInterval(() => {
      IntakeChatRepo.findReplyState(job.jobId)
        .then((state) => {
          if (state?.replyStatus === "CANCELLED") control.abort.abort();
        })
        .catch(() => {});
    }, CANCEL_POLL_INTERVAL_MS);

    try {
      await runInLlmUsageScope({ userId: job.userId, caseId: job.caseId }, () => IntakeChatSvc.runIntakeGenerationJob(job, control));
    } finally {
      clearInterval(cancelPoll);
      IntakeChatSvc.activeGenerations.delete(job.jobId);
    }
  }

  private static async runIntakeGenerationJob(job: IntakeChatGenerationJob, control: IntakeGenerationControl): Promise<void> {
    const { signal } = control.abort;
    const { jobId: parentMessageId, caseId, userId, sessionId, userInput } = job;

    const initialState = await IntakeChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (initialState?.replyStatus === "CANCELLED") return;

    const emitEvent = (event: string, payload: Record<string, unknown>) => {
      try {
        emitToUser(userId, event, { caseId, messageId: parentMessageId, ...payload });
      } catch (err) {
        logger.warn("Intake chat generation: emitToUser failed, continuing without it", { err, event, jobId: parentMessageId });
      }
    };
    emitEvent("chat:started", {});

    // Document excerpt grounding — the ambient-awareness requirement: reuses ClientIntakeSvc's
    // own excerpt-pack mechanism (not DocumentChunkSvc's embedding-chunk RAG chain, which is a
    // heavier, lawyer-Terminal-specific tool) so intake doesn't ask about something a document
    // already answers. READY documents only; a document still being read contributes nothing yet.
    let documentContext = "";
    try {
      const docs = await DocumentRepo.listAllByCase(caseId);
      const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
      if (ready.length) {
        const pack = await buildFactExcerptPack(ready);
        if (pack.text) {
          const excerpts = excerptsWithHandles(pack.text.slice(0, MAX_DOCUMENT_EXCERPT_CHARS), ready);
          documentContext = wrapExtractedText(
            "Facts already given in the client's uploaded documents — check here before asking something a document already answers.",
            excerpts,
          );
        }
      }
    } catch (err) {
      logger.warn("Intake chat generation: document excerpt grounding unavailable, continuing without it", { err, caseId });
    }

    let fullResponse: string;
    let lawyerMatches: unknown[] = [];
    let caseReady = false;
    const checkpointedOnChunk = (text: string) => {
      if (signal.aborted) return;
      emitEvent("chat:chunk", { chunk: text });
    };

    try {
      const result = await streamIntakeChatWonderMessage(sessionId, userInput, checkpointedOnChunk, documentContext || undefined, signal, () =>
        emitEvent("chat:answer-complete", {}),
      );
      fullResponse = redactDocumentIds(result.content, []);
      lawyerMatches = result.lawyerMatches;
      caseReady = result.caseReady;
    } catch (err) {
      if (err instanceof IntakeGenerationCancelledError) {
        logger.info("Intake chat generation: cancelled before completion", { jobId: parentMessageId, caseId });
        return;
      }
      logger.error("Intake chat generation: AI call failed", { err, jobId: parentMessageId, caseId });
      await IntakeChatRepo.setReplyStatus(parentMessageId, "FAILED", { clearPendingContent: true }).catch(() => {});
      emitEvent("chat:error", { message: "Generation failed" });
      throw err;
    }

    const stateBeforePersist = await IntakeChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (signal.aborted || stateBeforePersist?.replyStatus === "CANCELLED") {
      logger.info("Intake chat generation: cancelled before persistence, dropping reply", { jobId: parentMessageId, caseId });
      return;
    }

    const assistantMessage = await IntakeChatSvc.persistIntakeTurn({
      caseId,
      parentMessageId,
      userId,
      fullResponse,
      lawyerMatches,
      caseReady,
    });

    if (assistantMessage) {
      emitEvent("chat:done", { assistantMessageId: assistantMessage.id });
      if (lawyerMatches.length) emitEvent("intake:lawyer-matches", { assistantMessageId: assistantMessage.id, matches: lawyerMatches });
      if (caseReady) emitEvent("intake:case-ready", { assistantMessageId: assistantMessage.id });
    }

    // Every intake reply is one of ClientIntakeSvc's automatic refresh triggers — unconditional
    // here (unlike the old shared pipeline's CaseRepo.isClientWorkspaceCase check), since every
    // case this job ever processes IS a client case, by construction.
    void ClientIntakeSvc.scheduleAuto(caseId, userId, "chat").catch((err) =>
      logger.warn("Client intake: post-reply schedule failed", { err, caseId }),
    );
  }

  private static async persistIntakeTurn(p: {
    caseId: string;
    parentMessageId: string;
    userId: string;
    fullResponse: string;
    lawyerMatches: unknown[];
    caseReady: boolean;
  }): Promise<{ id: string } | null> {
    // SQS-redelivery idempotency: a worker crash after this point but before the ack means the
    // job redelivers — if a reply already exists for this parent, this is that redelivery, not a
    // second turn. Same guard as ChatRepo.findAssistantReplyByParent.
    const existing = await IntakeChatRepo.findAssistantReplyByParent(p.parentMessageId);
    if (existing) {
      await IntakeChatRepo.setReplyStatus(p.parentMessageId, "DONE", { clearPendingContent: true }).catch(() => {});
      return existing;
    }

    const content = p.fullResponse.trim();
    const assistantMessage = await IntakeChatRepo.createMessage(p.caseId, "assistant", content, undefined, undefined, undefined, p.parentMessageId);
    await IntakeChatRepo.setReplyStatus(p.parentMessageId, "DONE", { clearPendingContent: true });

    if (p.lawyerMatches.length) {
      await IntakeChatRepo.recordFindLawyerResult(assistantMessage.id, p.lawyerMatches as string[]).catch((err) =>
        logger.warn("Intake chat generation: failed to record find_lawyer result", { err, messageId: assistantMessage.id }),
      );
    }
    if (p.caseReady) {
      await IntakeChatRepo.markReady(assistantMessage.id).catch((err) =>
        logger.warn("Intake chat generation: failed to mark case ready", { err, messageId: assistantMessage.id }),
      );
    }

    return { id: assistantMessage.id };
  }
}
