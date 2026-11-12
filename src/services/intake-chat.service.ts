import type { ClientWorkspace } from "./client-case.service";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseRepo from "../repositories/case.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import CaseAreaSvc from "./case-area.service";
import ClientIntakeSvc from "./client-intake.service";
import IntakeChatGenerationQueue, { IntakeChatGenerationJob } from "../queues/intake-chat-generation.queue";
import { streamIntakeChatWonderMessage, getChatWonderSessionIdForIntake, IntakeGenerationCancelledError } from "../utils/intakeChatWonder";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import { excerptsWithHandles } from "../utils/case-document-handles";
import { caseDetailsBlock, readinessBlock } from "../utils/client-intake-extract";
import { redis } from "../lib/redis";
import { emitToUser } from "../lib/socket";
import { runInLlmUsageScope } from "../lib/llm-usage-scope";
import ConsentSvc from "./consent.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { stripStructuredBlocks } from "../utils/response-parser";
import { redactDocumentIds } from "../utils/document-references";
import { deleteFromS3, getProxyFileUrl, uploadToS3 } from "../utils/s3";
import SecurityAuditSvc from "./security-audit.service";
import { transcribeS3Media } from "./transcription.service";
import { synthesizeSpeechToBuffer } from "../utils/polly";
import { toSpeechPlainText } from "../utils/tts-text";

/** How a running intake turn is stopped — same shape as ChatSvc's GenerationControl, its own
 * copy (see intake-field-crypto.ts's doc comment on why duplication here is deliberate). */
interface IntakeGenerationControl {
  abort: AbortController;
  getPartial: () => string;
}

const CANCEL_POLL_INTERVAL_MS = 1_000;
const CHAT_WONDER_SESSION_TTL_S = 60 * 60 * 24; // 1 day, same as the lawyer/client pipeline's session TTL
const MAX_DOCUMENT_EXCERPT_CHARS = 12_000;

/** How much of the earlier chat is handed to a new Chat Wonder session (see earlierConversationBlock). */
const EARLIER_CONVERSATION_MAX_MESSAGES = 30;
const EARLIER_CONVERSATION_MAX_CHARS_PER_MESSAGE = 1_500;

/** Chat Wonder keeps sessions in memory and forgets them on restart; it then answers a turn on
 * the old session with "Unknown session." as its first frame, before any content. */
export function isUnknownSessionError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Unknown session");
}

/** The chat before the turn `currentMessageId`, oldest first, for a new Chat Wonder session that
 * never saw it. Intake relies on the session to remember the conversation (only the case details,
 * readiness and document excerpts are sent each turn), so without this the client's earlier
 * answers would be lost and the AI would start the interview over. Empty when there's no history. */
export function earlierConversationBlock(rows: { id: string; role: string; content: string }[], currentMessageId: string): string {
  const end = rows.findIndex((m) => m.id === currentMessageId);
  const before = (end < 0 ? rows : rows.slice(0, end))
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-EARLIER_CONVERSATION_MAX_MESSAGES);
  if (!before.length) return "";
  const lines = before.map((m) => `${m.role === "user" ? "Client" : "You"}: ${m.content.trim().slice(0, EARLIER_CONVERSATION_MAX_CHARS_PER_MESSAGE)}`);
  return `Earlier conversation with this client (the chat session was restarted, so it is repeated here). Carry on from it: don't greet the client again or ask what they've already answered.\n${lines.join("\n")}`;
}

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
      messages: visible.map((m) => {
        // audioKey (the client's own recording) on a user turn, replyAudioKey (the Polly
        // synthesis) on its assistant reply — never both on the same row. Inline disposition: it's
        // played in the chat, never offered as a download.
        const audioKey = m.role === "user" ? m.audioKey : m.replyAudioKey;
        return {
          id: m.id,
          role: m.role === "user" ? ("user" as const) : ("ai" as const),
          text: m.content,
          replyStatus: m.role === "user" ? m.replyStatus : null,
          // Document names/status aren't resolved inline here (IntakeMessage carries only ids, no
          // relation like Message.documents) — the frontend already has a document-list endpoint
          // for a case; resolve names there rather than duplicating that join on every message read.
          documentIds: m.role === "user" ? m.documentIds : [],
          audioUrl: audioKey ? getProxyFileUrl(audioKey, { disposition: "inline" }) : null,
          createdAt: m.createdAt,
        };
      }),
    };
  }

  /** Enqueues a turn on the intake pipeline's own queue. Credit spend/refund and attachment
   * ownership checks stay in ClientCaseSvc.sendMessage (the caller) — this only owns the
   * generation job itself, same split of responsibility ChatSvc.enqueueChatGeneration had.
   *
   * `audioKey` marks this as a voice turn: `text` is then just a placeholder (there's no
   * transcript yet), and the worker's first step (runIntakeGenerationJob) transcribes audioKey
   * and overwrites the placeholder with the real content before doing anything else. */
  static async enqueueIntakeGeneration(
    workspace: ClientWorkspace,
    userId: string,
    caseId: string,
    text: string,
    documentIds?: string[],
    audioKey?: string,
  ): Promise<{ messageId: string; sessionId: string; replyStatus: "PENDING" }> {
    const { sessionId, fresh } = await IntakeChatSvc.resolveSession(caseId);
    const userMessage = await IntakeChatRepo.createUserMessageIfNoPendingTurn(caseId, text, userId, documentIds, audioKey);
    if (!userMessage) {
      throw new HttpError("A reply is already generating for this case", 409);
    }

    const job: IntakeChatGenerationJob = {
      jobId: userMessage.id,
      tenantCode: workspace.tenantCode,
      userId,
      caseId,
      sessionId,
      userInput: text,
      documentIds,
      audioS3Key: audioKey,
      ...(fresh ? { replayHistory: true } : {}),
    };
    IntakeChatGenerationQueue.enqueue(job);
    return { messageId: userMessage.id, sessionId, replyStatus: "PENDING" };
  }

  /** The case's Chat Wonder session. `fresh` when it's a new one that has seen none of the chat so
   * far (the first turn, the cached id expired, or a message was deleted) — its first turn then
   * carries the earlier chat (see IntakeChatGenerationJob.replayHistory). */
  private static async resolveSession(caseId: string): Promise<{ sessionId: string; fresh: boolean }> {
    const stored = await redis.get<string>(intakeSessionKey(caseId));
    if (typeof stored === "string" && stored.length > 0) {
      await redis.set(intakeSessionKey(caseId), stored, CHAT_WONDER_SESSION_TTL_S);
      return { sessionId: stored, fresh: false };
    }
    return { sessionId: await IntakeChatSvc.newSession(caseId), fresh: true };
  }

  /** A fresh Chat Wonder session for the case, stored so the next turns use it too. */
  static async newSession(caseId: string): Promise<string> {
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

    // Refunds the turn's credit along with the flip, once — a second Stop, or a Stop that lost to
    // the worker's own DONE/FAILED, gets false here and refunds nothing.
    const cancelled = await IntakeChatRepo.endPendingTurn(messageId, caseId, "CANCELLED");
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

  /** Deletes a message from the case's chat — a user turn together with the answer to it, or just
   * an answer. Refused while that turn's answer is still being written (Stop it first). Never
   * refunds: the credit paid for an answer the client got. The case's Chat Wonder session is
   * dropped so the AI forgets what was deleted: the next turn starts a new session and is handed
   * the chat as it now stands. The deleted turn's recordings are removed from S3 as well. */
  static async deleteMessage(workspace: ClientWorkspace, caseId: string, messageId: string): Promise<void> {
    const message = await IntakeChatRepo.findInCase(messageId, caseId);
    if (!message || message.role === "system") throw new HttpError("Message not found", 404);
    if (message.role === "user" && message.replyStatus === "PENDING") {
      throw new HttpError("The answer to this message is still being written. Stop it first, then delete it.", 409, "TURN_IN_PROGRESS");
    }

    const audioKeys = await IntakeChatRepo.deleteTurn(messageId, caseId);
    await redis.del(intakeSessionKey(caseId));
    for (const key of audioKeys) {
      await deleteFromS3(key).catch((err) => logger.warn("Intake chat: couldn't remove a deleted message's audio", { err, caseId, key }));
    }
    await SecurityAuditSvc.record({
      action: "case.item_deleted",
      organizationId: workspace.id,
      targetType: "case_item",
      targetId: messageId,
      caseId,
      payload: { route: "/client/cases/:caseId/messages/:messageId", role: message.role },
    });
  }

  static async processIntakeGenerationJob(job: IntakeChatGenerationJob): Promise<void> {
    if (!(await ConsentSvc.isAllowed(job.userId, "AI_PROCESSING"))) {
      logger.info("Intake chat generation: skipped, AI processing consent is withdrawn", { jobId: job.jobId, caseId: job.caseId });
      await IntakeChatRepo.endPendingTurn(job.jobId, job.caseId, "FAILED").catch(() => {});
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
    const { jobId: parentMessageId, caseId, userId, sessionId } = job;
    let userInput = job.userInput;

    // A turn already stopped or failed (and refunded) — e.g. SQS redelivering after a crash — is
    // never answered again.
    const initialState = await IntakeChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (initialState?.replyStatus === "CANCELLED" || initialState?.replyStatus === "FAILED") return;

    const emitEvent = (event: string, payload: Record<string, unknown>) => {
      try {
        emitToUser(userId, event, { caseId, messageId: parentMessageId, ...payload });
      } catch (err) {
        logger.warn("Intake chat generation: emitToUser failed, continuing without it", { err, event, jobId: parentMessageId });
      }
    };
    emitEvent("chat:started", {});

    // A voice turn arrives with no transcript yet — userInput is just the placeholder
    // enqueueIntakeGeneration wrote. Transcribe before anything else so the rest of this function
    // (grounding, the chat-wonder call, persistence) never has to know a turn was spoken rather
    // than typed. Failing this fails the turn exactly like the AI-call failure path below.
    if (job.audioS3Key) {
      try {
        // A client talking to this chat is always one voice — never speaker-labelled, unlike the
        // evidence-transcription path this function also serves (recorded hearings, calls).
        // Diarization misfiring on a single speaker (a pause or pitch shift read as a second
        // speaker) would otherwise leak "[TS:0.82] [Speaker 0]: ..." tags into the chat transcript.
        const transcript = (await transcribeS3Media(job.audioS3Key, `voice-msg-${parentMessageId}`, { speakerLabels: false })).trim();
        if (!transcript) throw new Error("Transcribe returned an empty transcript");
        userInput = transcript;
        await IntakeChatRepo.setTranscribedContent(parentMessageId, transcript);
        emitEvent("chat:voice-transcribed", {});
      } catch (err) {
        logger.error("Intake chat generation: voice transcription failed", { err, jobId: parentMessageId, caseId });
        await IntakeChatRepo.endPendingTurn(parentMessageId, caseId, "FAILED").catch(() => {});
        emitEvent("chat:error", { message: "Couldn't transcribe that recording" });
        return;
      }
    }

    // Case-details grounding: what the client already answered on the case-creation wizard
    // (type of problem, jurisdiction, town, side, notes, named parties). Without this, intake has
    // no way to know those were already given and keeps re-asking for them turn after turn — this
    // was missing entirely until caught live (2026-10-29): the shared pipeline this replaced must
    // have carried it some other way, and it was never rebuilt here when the pipeline was split.
    let caseContext = "";
    try {
      const organizationId = await CaseRepo.findOrganizationId(caseId);
      const row = organizationId ? await ClientCaseRepo.findById(caseId, organizationId) : null;
      if (row) {
        const label = await CaseAreaSvc.labeller();
        caseContext = caseDetailsBlock(
          {
            title: row.caseName,
            caseAreas: label(row.caseAreas).map((a) => a.name),
            ukJurisdiction: row.ukJurisdiction,
            where: row.jurisdiction,
            side: row.clientSide,
            notes: row.notes,
          },
          row.parties.map((p) => ({ name: p.name, designation: p.designation })),
        );
      }
    } catch (err) {
      logger.warn("Intake chat generation: case-details grounding unavailable, continuing without it", { err, caseId });
    }

    // Readiness grounding: Jev's own independent check (confirmReadyWithJev below reuses the same
    // call) already decides every turn whether each must-have is covered — the same verdict the
    // client's readiness checklist UI shows. Without this, the model has to re-derive "already
    // answered" purely by re-reading raw chat text itself every turn, which is where the re-asking
    // bugs came from (caught live 2026-11-03): it kept asking things already answered — a goal
    // stated inline with the problem, "nothing's been signed" restated as an emphatic answer —
    // because nothing told it those were already settled. Cached per latest-AI-message-id
    // (ClientCaseSvc.lawyerReadiness), so this costs nothing extra beyond what the checklist UI's
    // own query already pays for the same turn.
    let readinessContext = "";
    try {
      const organizationId = await CaseRepo.findOrganizationId(caseId);
      if (organizationId) {
        const { default: ClientCaseSvc } = await import("./client-case.service");
        const workspace: ClientWorkspace = { id: organizationId, role: "OWNER", tenantCode: job.tenantCode };
        const readiness = await ClientCaseSvc.lawyerReadiness(workspace, userId, caseId);
        readinessContext = readinessBlock(readiness.criteria);
      }
    } catch (err) {
      logger.warn("Intake chat generation: readiness grounding unavailable, continuing without it", { err, caseId });
    }

    // Document excerpt grounding — the ambient-awareness requirement: reuses ClientIntakeSvc's
    // own excerpt-pack mechanism (not DocumentChunkSvc's embedding-chunk RAG chain, which is a
    // heavier, lawyer-Terminal-specific tool) so intake doesn't ask about something a document
    // already answers. READY documents only; a document still being read contributes nothing yet.
    let documentExcerptContext = "";
    // Every active document on the case, for redactDocumentIds below — a raw document id the
    // model repeats back (from an excerpt handle, or just guessed) gets swapped for its name
    // instead of leaking an internal uuid into the client's chat.
    let scopeDocs: { id: string; name: string }[] = [];
    try {
      const docs = await DocumentRepo.listAllByCase(caseId);
      scopeDocs = docs.map((d) => ({ id: d.id, name: d.name }));
      const ready = docs.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));
      if (ready.length) {
        const pack = await buildFactExcerptPack(ready);
        if (pack.text) {
          const excerpts = excerptsWithHandles(pack.text.slice(0, MAX_DOCUMENT_EXCERPT_CHARS), ready);
          documentExcerptContext = wrapExtractedText(
            "Facts already given in the client's uploaded documents — check here before asking something a document already answers.",
            excerpts,
          );
        }
      }
    } catch (err) {
      logger.warn("Intake chat generation: document excerpt grounding unavailable, continuing without it", { err, caseId });
    }

    // One combined block, under chat-wonder's single "[CASE CONTEXT]" label (intake_prompt.txt /
    // the_server.py's _document_context_injection) — case-form facts first, then document excerpts.
    const documentContext = [caseContext, readinessContext, documentExcerptContext].filter(Boolean).join("\n\n");

    let fullResponse: string;
    let lawyerMatches: unknown[] = [];
    let caseReady = false;
    // Checkpoints the raw accumulated reply into the user message's pendingReplyContent every
    // CHECKPOINT_INTERVAL_MS — same idiom as ChatSvc.runChatGenerationJob — so Stop/cancel has an
    // actual partial reply to save instead of control.getPartial()'s placeholder "", and a
    // mid-generation refresh can show progress instead of a bare "thinking" indicator.
    const CHECKPOINT_INTERVAL_MS = 1_000;
    let lastCheckpointAt = 0;
    let checkpointChain: Promise<unknown> = Promise.resolve();
    let accumulatedForCheckpoint = "";
    control.getPartial = () => accumulatedForCheckpoint;
    const checkpointedOnChunk = (text: string) => {
      if (signal.aborted) return;
      emitEvent("chat:chunk", { chunk: text });
      accumulatedForCheckpoint += text;
      const now = Date.now();
      if (now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        lastCheckpointAt = now;
        const snapshot = accumulatedForCheckpoint;
        checkpointChain = checkpointChain
          .then(() => IntakeChatRepo.checkpointPendingReply(parentMessageId, snapshot))
          .catch((err) => logger.warn("Intake chat generation: pending-reply checkpoint failed", { err, messageId: parentMessageId }));
      }
    };

    const stream = (sid: string, context: string) =>
      streamIntakeChatWonderMessage(sid, userInput, checkpointedOnChunk, context || undefined, signal, () => emitEvent("chat:answer-complete", {}), caseId, userId);
    // documentContext plus the chat before this turn, for a session that has never seen it.
    const withEarlierChat = async () =>
      [documentContext, earlierConversationBlock(await IntakeChatRepo.listByCase(caseId), parentMessageId)].filter(Boolean).join("\n\n");

    try {
      let result: Awaited<ReturnType<typeof stream>>;
      try {
        // A new session (the first turn, an expired session, or a deleted message) is handed the
        // chat as it stands now; a failed read just means this turn goes without it.
        const firstContext = job.replayHistory
          ? await withEarlierChat().catch((err) => {
              logger.warn("Intake chat generation: couldn't read the earlier chat for a new session, continuing without it", { err, caseId });
              return documentContext;
            })
          : documentContext;
        result = await stream(sessionId, firstContext);
      } catch (err) {
        // Chat Wonder forgot the session (it restarted): every turn on it would fail the same way
        // until the cached id expired, so start a new one now, store it for the next turns, and
        // hand it the earlier chat it never saw. Safe to send again: "Unknown session." arrives
        // before any content, so nothing has been streamed to the client yet. Same recovery as
        // the lawyer chat's ChatSvc.streamWithSessionRetry.
        if (!isUnknownSessionError(err)) throw err;
        logger.warn("Intake chat generation: Chat Wonder no longer knows the session; starting a new one", { caseId, jobId: parentMessageId });
        const freshSessionId = await IntakeChatSvc.newSession(caseId);
        result = await stream(freshSessionId, await withEarlierChat());
      }
      await checkpointChain;
      fullResponse = redactDocumentIds(result.content, scopeDocs);
      lawyerMatches = result.lawyerMatches;
      caseReady = result.caseReady;
    } catch (err) {
      if (err instanceof IntakeGenerationCancelledError) {
        logger.info("Intake chat generation: cancelled before completion", { jobId: parentMessageId, caseId });
        return;
      }
      logger.error("Intake chat generation: AI call failed", { err, jobId: parentMessageId, caseId });
      await IntakeChatRepo.endPendingTurn(parentMessageId, caseId, "FAILED").catch(() => {});
      emitEvent("chat:error", { message: "Generation failed" });
      throw err;
    }

    const stateBeforePersist = await IntakeChatRepo.findReplyState(parentMessageId).catch(() => null);
    if (signal.aborted || stateBeforePersist?.replyStatus === "CANCELLED" || stateBeforePersist?.replyStatus === "FAILED") {
      logger.info("Intake chat generation: turn stopped or failed before persistence, dropping reply", { jobId: parentMessageId, caseId });
      return;
    }

    const assistantMessage = await IntakeChatSvc.persistIntakeTurn({
      caseId,
      parentMessageId,
      userId,
      fullResponse,
      lawyerMatches,
    });

    // mark_case_ready() is intake's own self-report — it can jump the gun or misjudge. Jev's
    // existing, independent per-criterion check (lawyer-readiness-jev.ts, already live for the
    // "suggest a lawyer" offer) is the actual gate: only once Jev agrees does this turn count as
    // ready, so a premature or hallucinated tool call never flips the case ready on intake's say
    // alone. Checked only now, after persisting, so Jev sees this very turn, not the one before it.
    let caseReadyConfirmed = false;
    if (assistantMessage && caseReady) {
      caseReadyConfirmed = await IntakeChatSvc.confirmReadyWithJev(job).catch((err) => {
        logger.warn("Intake chat generation: Jev readiness gate failed, not marking ready", { err, caseId });
        return false;
      });
      if (caseReadyConfirmed) {
        logger.info("Intake chat generation: Jev agreed, marking case ready", { caseId, messageId: assistantMessage.id });
        await IntakeChatRepo.markReady(assistantMessage.id).catch((err) =>
          logger.warn("Intake chat generation: failed to mark case ready", { err, messageId: assistantMessage.id }),
        );
      } else {
        logger.info("Intake chat generation: intake declared ready but Jev disagreed, not acting on it", { caseId, messageId: assistantMessage.id });
      }
    }

    // Voice turn: synthesize the reply's audio BEFORE chat:done fires, so that event always means
    // "everything, including audio, is ready" — never a second event the client has to wait on
    // separately. A synthesis failure here must not fail a turn whose text answer is already
    // good and already persisted; the client still gets a text-only reply.
    if (assistantMessage && job.audioS3Key) {
      try {
        const speechText = toSpeechPlainText(fullResponse);
        const audio = await synthesizeSpeechToBuffer(speechText);
        const replyAudioKey = `voice-messages/${caseId}/${assistantMessage.id}-reply.mp3`;
        await uploadToS3(replyAudioKey, audio, "audio/mpeg");
        await IntakeChatRepo.setReplyAudio(assistantMessage.id, replyAudioKey);
      } catch (err) {
        logger.error("Intake chat generation: voice reply synthesis failed, continuing text-only", { err, caseId, messageId: assistantMessage.id });
      }
    }

    if (assistantMessage) {
      emitEvent("chat:done", { assistantMessageId: assistantMessage.id });
      if (lawyerMatches.length) emitEvent("intake:lawyer-matches", { assistantMessageId: assistantMessage.id, matches: lawyerMatches });
      if (caseReadyConfirmed) emitEvent("intake:case-ready", { assistantMessageId: assistantMessage.id });
    }

    // Every intake reply is one of ClientIntakeSvc's automatic refresh triggers — unconditional
    // here (unlike the old shared pipeline's CaseRepo.isClientWorkspaceCase check), since every
    // case this job ever processes IS a client case, by construction. Keeping this unconditional
    // (not gated on caseReadyConfirmed) means the overview stays fresh turn by turn regardless;
    // intake:case-ready is the separate, gated "present it for the client to review now" signal.
    void ClientIntakeSvc.scheduleAuto(caseId, userId, "chat").catch((err) =>
      logger.warn("Client intake: post-reply schedule failed", { err, caseId }),
    );
  }

  /** Jev's own verdict (ClientCaseSvc.lawyerReadiness) on whether this case is actually ready —
   * the gate on intake's mark_case_ready(). A dynamic import, not a top-level one: client-case
   * .service.ts already imports this file (for listMessages/enqueueIntakeGeneration), so a
   * top-level import back would be a require cycle. Only workspace.id is read downstream (case
   * scoping); role is never checked for this read-only call. */
  private static async confirmReadyWithJev(job: IntakeChatGenerationJob): Promise<boolean> {
    logger.info("Intake chat generation: intake declared ready, asking Jev to confirm", { caseId: job.caseId });
    const organizationId = await CaseRepo.findOrganizationId(job.caseId);
    if (!organizationId) {
      logger.warn("Intake chat generation: Jev gate aborted, no organization for case", { caseId: job.caseId });
      return false;
    }
    const { default: ClientCaseSvc } = await import("./client-case.service");
    const workspace: ClientWorkspace = { id: organizationId, role: "OWNER", tenantCode: job.tenantCode };
    const readiness = await ClientCaseSvc.lawyerReadiness(workspace, job.userId, job.caseId);
    logger.info("Intake chat generation: Jev verdict", { caseId: job.caseId, ready: readiness.ready, caseAreas: readiness.caseAreas });
    return readiness.ready;
  }

  private static async persistIntakeTurn(p: {
    caseId: string;
    parentMessageId: string;
    userId: string;
    fullResponse: string;
    lawyerMatches: unknown[];
  }): Promise<{ id: string } | null> {
    // SQS-redelivery idempotency: a worker crash after this point but before the ack means the
    // job redelivers — if a reply already exists for this parent, this is that redelivery, not a
    // second turn. Same guard as ChatRepo.findAssistantReplyByParent. The reply and the turn's DONE
    // are written together (completeTurn), so an existing reply means the turn has already ended.
    const existing = await IntakeChatRepo.findAssistantReplyByParent(p.parentMessageId);
    if (existing) return existing;

    // Saved only if the turn is still PENDING: one the client stopped, or the stale sweep failed,
    // has had its credit back, so its answer is dropped rather than delivered.
    const assistantMessage = await IntakeChatRepo.completeTurn(p.parentMessageId, p.caseId, p.fullResponse.trim());
    if (!assistantMessage) {
      logger.info("Intake chat generation: turn ended before its answer was saved, dropping reply", { jobId: p.parentMessageId, caseId: p.caseId });
      return null;
    }

    if (p.lawyerMatches.length) {
      await IntakeChatRepo.recordFindLawyerResult(assistantMessage.id, p.lawyerMatches as string[]).catch((err) =>
        logger.warn("Intake chat generation: failed to record find_lawyer result", { err, messageId: assistantMessage.id }),
      );
    }

    return { id: assistantMessage.id };
  }
}
