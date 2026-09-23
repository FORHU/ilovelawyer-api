import { Server as IOServer, Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";
import { ACCESS_TOKEN_SECRET, CLIENT_URL } from "../config";
import CaseAccess from "../utils/case-access";
import logger from "../utils/logger";

let io: IOServer | null = null;

/** Live Case Document extraction events pushed by DocumentExtractionSvc. `Document.ragStatus` in
 * the database stays the source of truth — these only let a connected client skip polling. */
export type DocumentSocketEvent = "document:started" | "document:ready" | "document:failed" | "document:retrying";

export interface DocumentSocketPayload {
  documentId: string;
  caseId: string | null;
  consultationId: string | null;
  ragStatus: "PENDING" | "READY" | "FAILED";
  /** READY only. */
  pageCount?: number | null;
  /** READY only — the AI-assigned category, if categorization finished. */
  category?: string | null;
}

/** AiGenerationLockSvc's job status events — pushed to every viewer of a case, not just
 * whoever triggered the job (unlike DocumentSocketEvent/emitToUser): the lock itself is keyed
 * on caseId+kind, not userId, since the result (Legal Issues, a narrative, a red-team scan) is
 * shared case analysis every lawyer on it reads from the same Terminal. */
export type AiJobSocketEvent = "ai-job:started" | "ai-job:done" | "ai-job:failed";

export interface AiJobSocketPayload {
  caseId: string;
  /** One of AI_GENERATION_KINDS (constants/ai-generation-kinds.ts) — kept as `string` here
   * rather than importing that type, so this low-level transport module doesn't need to know
   * about a domain-specific enum; callers pass a real AiGenerationKind. */
  kind: string;
  status: "IN_PROGRESS" | "DONE" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

function roomForUser(userId: string): string {
  return `user:${userId}`;
}

function roomForCase(caseId: string): string {
  return `case:${caseId}`;
}

/**
 * One socket.io server for the whole app (not per-feature) — a client opens a single
 * connection and receives every push it's entitled to (today: just notification:new) on
 * whatever room its userId maps it into. Auth mirrors valid-session.middleware.ts: the same
 * short-lived access token sent as `Authorization: Bearer` on REST calls, passed here as
 * `socket.handshake.auth.token` — there's no separate socket-specific credential.
 */
export function initSocket(server: HTTPServer): IOServer {
  io = new IOServer(server, {
    cors: {
      origin: CLIENT_URL,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  logger.info("Socket.IO: server initialized", { corsOrigins: CLIENT_URL });

  // Fires for a handshake that never reaches io.use() at all — wrong CORS origin, a malformed
  // request, or the transport itself failing. Temporary debugging aid: if a client's connection
  // attempt shows nothing anywhere else in these logs, this is the one place that would catch it.
  io.engine.on("connection_error", (err) => {
    logger.error("Socket.IO: connection_error (never reached io.use)", {
      code: err.code,
      message: err.message,
      context: err.context,
    });
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    logger.info("Socket.IO: handshake received", {
      socketId: socket.id,
      hasToken: !!token,
      origin: socket.handshake.headers.origin,
    });
    if (!token || typeof token !== "string") {
      logger.warn("Socket.IO: rejected — no token in handshake.auth", { socketId: socket.id });
      return next(new Error("Unauthorized"));
    }

    jwt.verify(token, ACCESS_TOKEN_SECRET, (err, payload) => {
      if (err || !payload || typeof payload === "string") {
        logger.warn("Socket.IO: rejected — invalid/expired token", { socketId: socket.id, err: err?.message });
        return next(new Error("Unauthorized"));
      }
      socket.data.userId = (payload as { userId: string }).userId;
      next();
    });
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    logger.info("Socket.IO: connected", { socketId: socket.id, userId });
    socket.join(roomForUser(userId));

    socket.on("disconnect", (reason) => {
      logger.info("Socket.IO: disconnected", { socketId: socket.id, userId, reason });
    });

    // Case rooms are opt-in and access-checked per join (unlike the user room above, which every
    // connection gets automatically) — a socket only sees ai-job:* events for cases it explicitly
    // subscribed to, and only after the same CaseAccess check every case-scoped HTTP route uses.
    // `ack` is a socket.io acknowledgement callback (the client's 2nd emit arg) — used by
    // useCaseRoom so it can confirm the join actually succeeded before relying on push over poll.
    socket.on("case:subscribe", async (payload: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      logger.info("Socket.IO: case:subscribe received", { socketId: socket.id, userId, payload });
      const caseId = (payload as { caseId?: unknown })?.caseId;
      if (typeof caseId !== "string" || !caseId) {
        logger.warn("Socket.IO: case:subscribe — invalid caseId in payload", { socketId: socket.id, payload });
        return ack?.({ ok: false, error: "Invalid caseId" });
      }

      try {
        await CaseAccess.loadAccessibleCase(caseId, userId);
      } catch (err) {
        logger.warn("case:subscribe: access denied", { err, userId, caseId });
        return ack?.({ ok: false, error: "Not authorized for this case" });
      }

      socket.join(roomForCase(caseId));
      logger.info("Socket.IO: case:subscribe joined", { socketId: socket.id, userId, caseId, room: roomForCase(caseId) });
      ack?.({ ok: true });
    });

    socket.on("case:unsubscribe", (payload: unknown) => {
      const caseId = (payload as { caseId?: unknown })?.caseId;
      if (typeof caseId === "string" && caseId) {
        socket.leave(roomForCase(caseId));
        logger.info("Socket.IO: case:unsubscribe left", { socketId: socket.id, userId, caseId });
      }
    });
  });

  return io;
}

/**
 * Best-effort push to every open connection for `userId` — the REST endpoints
 * (GET /api/notifications, /unread-count) remain the source of truth, so a dropped
 * connection or a call made before initSocket() runs (e.g. a script/test) just means the
 * client picks the change up on its next poll/refetch instead of instantly. Never throws.
 */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  if (!io) {
    logger.warn("emitToUser: socket.io not initialized, skipping", { event, userId });
    return;
  }
  const room = roomForUser(userId);
  const recipients = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  logger.info("Socket.IO: emitToUser", { event, userId, room, recipients });
  io.to(room).emit(event, payload);
}

/** Best-effort push to every socket currently subscribed to `caseId` (see the case:subscribe
 * handler above) — same never-throws, no-op-if-uninitialized contract as emitToUser. */
export function emitToCase(caseId: string, event: string, payload: unknown): void {
  if (!io) {
    logger.warn("emitToCase: socket.io not initialized, skipping", { event, caseId });
    return;
  }
  const room = roomForCase(caseId);
  const recipients = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  logger.info("Socket.IO: emitToCase", { event, caseId, room, recipients });
  io.to(room).emit(event, payload);
}
