import { Server as IOServer, Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";
import { ACCESS_TOKEN_SECRET, CLIENT_URL } from "../config";
import logger from "../utils/logger";

let io: IOServer | null = null;

function roomForUser(userId: string): string {
  return `user:${userId}`;
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

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== "string") return next(new Error("Unauthorized"));

    jwt.verify(token, ACCESS_TOKEN_SECRET, (err, payload) => {
      if (err || !payload || typeof payload === "string") return next(new Error("Unauthorized"));
      socket.data.userId = (payload as { userId: string }).userId;
      next();
    });
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    socket.join(roomForUser(userId));
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
  io.to(roomForUser(userId)).emit(event, payload);
}
