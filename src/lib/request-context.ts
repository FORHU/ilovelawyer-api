import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

/** Who and where the current HTTP request came from, readable anywhere below the route handler
 * without threading `req` through every service — SecurityAuditSvc.record fills a row's ip,
 * userAgent, requestId, actor and organization from it. Reads `req.user` / `req.organization`
 * lazily, since validSession and resolveOrganization set them after this middleware runs. Empty
 * outside a request (queues, cron), where callers name the actor themselves. */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  userId(): string | null;
  organizationId(): string | null;
  tenantCode(): string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Runs `fn` inside `context` — for tests, and for code that needs a context outside Express. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context each request was given, so it can be re-entered where Node lost it: multer (and
 * any busboy-based parser) calls next() from a stream event, outside the request's async chain. */
const contextByRequest = new WeakMap<Request, RequestContext>();

/** Runs `fn` in `req`'s context unless that context is already the active one. */
export function withRequestContextOf<T>(req: Request, fn: () => T): T {
  const context = contextByRequest.get(req);
  if (!context || storage.getStore() === context) return fn();
  return storage.run(context, fn);
}

const REQUEST_ID_HEADER = "x-request-id";

/** Mounted once in app.ts, before the router. Reuses an incoming X-Request-Id (from a load
 * balancer or the app's server-side calls) when it looks sane, else mints one, and echoes it
 * back so a support ticket can quote it. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const userAgent = req.headers["user-agent"];
  const context: RequestContext = {
    requestId,
    // trust proxy is set in app.ts, so this is the client's address, not the load balancer's.
    ip: req.ip ?? null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    userId: () => req.user?.userId ?? null,
    organizationId: () => req.organization?.id ?? null,
    tenantCode: () => req.organization?.tenantCode ?? null,
  };
  contextByRequest.set(req, context);
  storage.run(context, () => next());
}
