import * as dotenv from "dotenv";
dotenv.config();

export const DATABASE_URL = process.env.DATABASE_URL as string;
export const PORT = Number(process.env.PORT || 3001);
export const SECRET_KEY = process.env.SECRET_KEY as string;
export const isDev = process.env.NODE_ENV !== "production";
export const MAILER_FROM = (process.env.MAILER_FROM || process.env.MAILER_EMAIL) as string;
export const MAILER_TRANSPORT_HOST = process.env.MAILER_TRANSPORT_HOST as string;
export const MAILER_TRANSPORT_PORT = Number(process.env.MAILER_TRANSPORT_PORT || 587);
export const MAILER_TRANSPORT_SECURE = process.env.MAILER_TRANSPORT_SECURE === "true";
export const MAILER_EMAIL = process.env.MAILER_EMAIL as string;
export const MAILER_PASSWORD = process.env.MAILER_PASSWORD as string;
export const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET as string;
export const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET as string;
export const ACCESS_TOKEN_EXPIRY = (process.env.ACCESS_TOKEN_EXPIRY || "1d") as string;
/** JWT timespan from env (e.g. "30d"). */
export const REFRESH_TOKEN_EXPIRY = (() => {
    const raw = (process.env.REFRESH_TOKEN_EXPIRY_DAYS || "30d").trim();
    return /d$/i.test(raw) ? raw : `${raw}d`;
})();
/** Day count for cookies/DB expiry math. */
export const REFRESH_TOKEN_EXPIRY_DAYS = (() => {
    const days = Number(REFRESH_TOKEN_EXPIRY.replace(/d$/i, ""));
    if (!Number.isFinite(days) || days <= 0) {
        throw new Error(
            `REFRESH_TOKEN_EXPIRY_DAYS must be a positive day count like "30" or "30d" (got ${JSON.stringify(process.env.REFRESH_TOKEN_EXPIRY_DAYS)})`,
        );
    }
    return days;
})();
export const REDIS_URL = process.env.REDIS_URL as string;
export const REDIS_HOST = process.env.REDIS_HOST as string;
export const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD as string;
export const SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT as string;
export const CLIENT_URL = (process.env.CLIENT_URL || "").split(",").map((origin) => origin.trim()).filter(Boolean);
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID as string;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET as string;
export const CHAT_WONDER_API_URL = (process.env.CHAT_WONDER_API_URL || "").replace(/\/+$/, "");
export const CHAT_WONDER_WS_URL = process.env.CHAT_WONDER_WS_URL as string;
/** juris.ph public API root (no version/segment). juris-ph.ts appends `/v1/...` for the
 * search API and `/qdrant/<collection>/...` for the scroll + retrieve endpoints. Trailing
 * slash trimmed. */
export const JURIS_PH_API_URL = (process.env.JURIS_PH_API_URL || "https://juris.ph/api").replace(/\/+$/, "");
/** UK Legal MCP — public, unauthenticated, stateless JSON-RPC over HTTP (see ADR-0003 in
 * chat-wonder-v2-api, which already calls this same server from the AI chat's tool loop).
 * uk-legal-mcp.ts posts `tools/call` requests directly at this one endpoint. */
export const UK_LEGAL_MCP_URL = process.env.UK_LEGAL_MCP_URL || "https://uk-legal-mcp.fly.dev/mcp";
/** The National Archives Find Case Law base — a UK judgment's canonical URL is
 * `${UK_CASELAW_BASE_URL}/<slug>` (slug e.g. "uksc/2024/12"). Used to build `Law.jurisUrl` for
 * UK case-law rows (uk-law-mappers.ts) and to strip it back to a slug (uk-citation-resolution.ts);
 * both MUST agree, so it lives here. Trailing slash trimmed. */
export const UK_CASELAW_BASE_URL = (
  process.env.UK_CASELAW_BASE_URL || "https://caselaw.nationalarchives.gov.uk"
).replace(/\/+$/, "");
/** legislation.gov.uk base — a UK Act/SI's canonical URL is
 * `${UK_LEGISLATION_BASE_URL}/<type>/<year>/<number>`. Used to parse a stored legislation URL
 * back into `{ type, year, number }` for the UK Legal MCP's legislation tools. Trailing slash
 * trimmed. */
export const UK_LEGISLATION_BASE_URL = (
  process.env.UK_LEGISLATION_BASE_URL || "https://www.legislation.gov.uk"
).replace(/\/+$/, "");
/** Shared secret Chat Wonder sends back to us via `x-api-key` when it calls our API (e.g. to fetch case document chunks). */
export const CHAT_WONDER_API_KEY = process.env.CHAT_WONDER_API_KEY as string;
export const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY as string;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY as string;
export const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET as string;
export const AWS_REGION = process.env.AWS_REGION as string;
/** Redirects the SQS client (only) at a local emulator (LocalStack) instead of real AWS — see
 * src/lib/sqs.ts. Left unset in production, which keeps talking to real AWS unchanged. Local
 * dev sets this to http://localhost:4566 (see .env.example) so each developer's own LocalStack
 * instance is the only thing their SQS traffic can ever reach — no shared AWS queue in dev. */
export const AWS_SQS_ENDPOINT = process.env.AWS_SQS_ENDPOINT || undefined;
// SQS queue URLs — one per background job type, provisioned externally (same convention as
// AWS_S3_BUCKET above: this app never creates its own AWS infra, only references it).
export const DOCUMENT_EXTRACTION_QUEUE_URL = process.env.DOCUMENT_EXTRACTION_QUEUE_URL as string;
export const CITATION_EXTRACTION_QUEUE_URL = process.env.CITATION_EXTRACTION_QUEUE_URL as string;
export const AUDIO_OVERVIEW_QUEUE_URL = process.env.AUDIO_OVERVIEW_QUEUE_URL as string;
export const CASE_RECONSTRUCTION_AUDIO_QUEUE_URL = process.env.CASE_RECONSTRUCTION_AUDIO_QUEUE_URL as string;
/** Shared by every lawyer-triggered Legal Terminal Generate/Refresh action (Refresh Analysis,
 * Red Team, Case Reconstruction) — see queues/ai-generation.queue.ts. */
export const AI_GENERATION_QUEUE_URL = process.env.AI_GENERATION_QUEUE_URL as string;
/** A chat turn's full AI-generation lifecycle (RAG, cache check, AI streaming, canonical
 * persistence) — owned by the worker, not the original HTTP request. See
 * queues/chat-generation.queue.ts. Reuses the queue that predates chat generation being
 * queue-driven at all (it used to be where the chat message itself got persisted, back when
 * everything else ran synchronously in the request) — one queue, one consumer. */
export const MESSAGE_PERSISTENCE_QUEUE_URL = process.env.MESSAGE_PERSISTENCE_QUEUE_URL as string;
/** Case-graph enrichment for an already-persisted chat turn (timeline/decision-record
 * promotion) — see queues/case-graph-promotion.queue.ts. Its own dedicated queue: it must
 * NOT share a physical SQS queue with MESSAGE_PERSISTENCE_QUEUE_URL (or any other queue) —
 * two independent consumers polling the same queue will randomly steal each other's messages,
 * since SQS has no concept of message "type" routing between consumers. */
export const CASE_GRAPH_PROMOTION_QUEUE_URL = process.env.CASE_GRAPH_PROMOTION_QUEUE_URL as string;
export const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL as string;
/** Signs/verifies the `/files/<jwt>` proxy links minted by getProxyFileUrl (src/utils/s3.ts) —
 * a missing secret would otherwise sign tokens with the literal string "undefined". */
export const FILE_TOKEN_SECRET = (() => {
  const secret = process.env.FILE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("FILE_TOKEN_SECRET must be set (signs the /files/<token> proxy links)");
  }
  return secret;
})();
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
export const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL as string;
export const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD as string;
/** Defaults to relying on PATH (works in the Docker image — `apk add ffmpeg` puts it there).
 * Override locally when a fresh install's PATH change hasn't propagated to the running shell
 * yet (a Windows/winget quirk, not something restarting nodemon alone fixes) — point this at
 * the binary directly instead. */
export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

/** Build the case mind map from uploaded documents as part of the post-upload refresh
 * (CaseMindMapSvc, called from CaseRefreshSvc). On unless set to "false" — the kill switch for
 * this automatic run only; a lawyer's explicit Regenerate on the case map still works. */
export const CASE_MIND_MAP_AUTO = process.env.CASE_MIND_MAP_AUTO !== "false";
