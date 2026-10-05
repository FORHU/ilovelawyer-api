import { CHAT_WONDER_API_URL, TRACE_STREAM_API_KEY } from "../config";
import TraceRepo from "../repositories/trace.repository";
import { randomUUID } from "crypto";
import { TraceSource } from "../constants/trace.constants";
import logger from "../utils/logger";
import { SseParser, parseStreamPayload } from "../utils/trace-stream.utils";

/** Who and what a turn's trace belongs to. `turnId` is the user Message that asked (a chat turn) or
 * a generated id (a pane's run). */
export interface TraceTurn {
  /** Null for a run that belongs to a pane, not a chat. */
  consultationId: string | null;
  caseId: string | null;
  organizationId: string | null;
  source: TraceSource;
  turnId: string;
  userId: string | null;
}

/** One AI generation a pane runs — witness scoring, case reconstruction, ... — to be traced. Made
 * once per logical run and passed to every attempt of it, so a retry on a fresh session adds to the
 * same entry in the pane instead of starting a second one. */
export interface TraceRun {
  source: TraceSource;
  caseId: string;
  userId: string | null;
  turnId: string;
}

export function newTraceRun(source: TraceSource, caseId: string, userId?: string | null): TraceRun {
  return { source, caseId, userId: userId ?? null, turnId: randomUUID() };
}

export interface TraceCollector {
  /** Moves collection to a new chat-wonder session — the turn's session was replaced mid-turn. */
  rebind(sessionId: string): Promise<void>;
  /** Ends collection after a short drain for events still in flight. Never throws. */
  stop(): Promise<void>;
}

/** How long to wait for the stream's "connected" event before the turn goes ahead untraced. The
 * subscription only exists once it arrives, and chat-wonder fans events out live (no replay), so
 * starting the turn sooner would lose its first events. Short: tracing must never hold up an answer. */
const CONNECT_TIMEOUT_MS = 2000;
/** Events are emitted before the answer's final frame but travel through chat-wonder's queue and
 * the SSE socket, so they can land just after the turn resolves. */
const DRAIN_MS = 300;

const NOOP: TraceCollector = { rebind: async () => {}, stop: async () => {} };

/**
 * Records a chat turn's customer-facing trace to the database while the turn runs — server-side,
 * for the whole turn, whether or not anyone has the pane open. Consumes chat-wonder's
 * session-scoped trace stream (GET /trace-stream/:session_id) and stores each event under the
 * consultation and turn, so the log survives the chat-wonder session being replaced.
 *
 * Strictly best-effort: every failure here is logged and swallowed. A trace is an explanation of
 * an answer, never a reason for the answer not to arrive.
 */
export default class TraceCollectorSvc {
  static async start(turn: TraceTurn, sessionId: string): Promise<TraceCollector> {
    if (!CHAT_WONDER_API_URL || !TRACE_STREAM_API_KEY) return NOOP;
    const collector = new ActiveCollector(turn);
    await collector.open(sessionId);
    return collector;
  }

  /** Start tracing one attempt of a pane's run. Looks the case's organization up itself; like
   * start(), it never throws — a failure here just means this run goes untraced. */
  static async startRun(run: TraceRun, sessionId: string): Promise<TraceCollector> {
    try {
      // A run with no real case has nowhere to be recorded (rows are tied to their case).
      const organizationId = run.caseId ? await TraceRepo.caseOrganizationId(run.caseId) : undefined;
      if (organizationId === undefined) return NOOP;
      return await TraceCollectorSvc.start(
        { consultationId: null, caseId: run.caseId, organizationId, source: run.source, turnId: run.turnId, userId: run.userId },
        sessionId,
      );
    } catch (err) {
      logger.warn("Trace: could not start tracing a run", { err, source: run.source, caseId: run.caseId });
      return NOOP;
    }
  }
}

class ActiveCollector implements TraceCollector {
  private abort?: AbortController;
  private reading?: Promise<void>;
  /** Inserts run one after another so rows are stored in arrival order (seq is assigned by insert). */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly turn: TraceTurn) {}

  async open(sessionId: string): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => (markConnected = resolve));
    this.reading = this.read(sessionId, abort.signal, markConnected).catch((err) => {
      if (!abort.signal.aborted) logger.warn("Trace: stream ended unexpectedly", { err, turnId: this.turn.turnId });
    });
    // Resolves on "connected", on a failed connect (read() releases it in `finally`), or on timeout.
    await Promise.race([connected, new Promise<void>((resolve) => setTimeout(resolve, CONNECT_TIMEOUT_MS))]);
  }

  async rebind(sessionId: string): Promise<void> {
    await this.close();
    await this.open(sessionId);
  }

  async stop(): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
      await this.close();
      await this.writes;
    } catch (err) {
      logger.warn("Trace: stop failed", { err, turnId: this.turn.turnId });
    }
  }

  private async close() {
    this.abort?.abort();
    await this.reading;
  }

  private async read(sessionId: string, signal: AbortSignal, markConnected: () => void) {
    try {
      const res = await fetch(`${CHAT_WONDER_API_URL}/trace-stream/${encodeURIComponent(sessionId)}`, {
        headers: { "x-api-key": TRACE_STREAM_API_KEY, Accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) {
        logger.warn("Trace: chat-wonder refused the scoped stream", { status: res.status, turnId: this.turn.turnId });
        return;
      }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
          const parsed = parseStreamPayload(payload, this.turn.turnId);
          if (parsed.kind === "connected") markConnected();
          else if (parsed.kind === "event") this.store(sessionId, parsed.event);
        }
      }
    } finally {
      markConnected();
    }
  }

  private store(sessionId: string, event: { type: string; summary: string; createdAt: Date }) {
    this.writes = this.writes
      .then(() =>
        TraceRepo.insertEvent({
          consultationId: this.turn.consultationId,
          caseId: this.turn.caseId,
          organizationId: this.turn.organizationId,
          source: this.turn.source,
          turnId: this.turn.turnId,
          userId: this.turn.userId,
          sessionId,
          ...event,
        }),
      )
      .catch((err) => logger.warn("Trace: could not store event", { err, turnId: this.turn.turnId }));
  }
}
