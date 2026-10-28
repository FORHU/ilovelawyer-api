import * as dotenv from "dotenv";
dotenv.config();

export const DATABASE_URL = process.env.DATABASE_URL as string;
export const PORT = Number(process.env.PORT || 3001);
export const SECRET_KEY = process.env.SECRET_KEY as string;
export const isDev = process.env.NODE_ENV !== "production";
/** AI answers a landing-page trial guest gets (TrialSvc). A missing or non-positive value uses 5. */
const trialMessageLimit = Math.floor(Number(process.env.TRIAL_MESSAGE_LIMIT));
export const TRIAL_MESSAGE_LIMIT = trialMessageLimit > 0 ? trialMessageLimit : 5;
/** How long a trial guest's session lasts, in hours (decimals allowed). A missing or non-positive
 * value uses 2: long enough for a demo at an event. */
const trialDurationHours = Number(process.env.TRIAL_DURATION_HOURS);
export const TRIAL_DURATION_HOURS = trialDurationHours > 0 ? trialDurationHours : 2;
export const TRIAL_DURATION_MS = TRIAL_DURATION_HOURS * 60 * 60 * 1000;
/** The one shared sample case every "Explore a sample case file" guest looks at, read-only
 * (TrialSvc): a case in its owner's portfolio. Unset: the trial offers the free chat only. */
export const TRIAL_SAMPLE_CASE_ID = process.env.TRIAL_SAMPLE_CASE_ID || "";
/** US dollars of OpenAI usage through Chat Wonder every new account (PH and UK, email or Google
 * sign-up) gets free, stored on the account at sign-up (User.freeCreditUsd). Set in the environment
 * only; unset or not a positive number, it is null, new accounts get no credit and are not limited,
 * and the server logs an error at startup. */
const freeCreditUsd = Number(process.env.FREE_CREDIT_USD);
export const FREE_CREDIT_USD = freeCreditUsd > 0 ? freeCreditUsd : null;
/** AccountLimitsSvc's fallback case limit for a LAWYER with no tenant at all (a legacy/edge case) —
 * a tenant-scoped lawyer's case limit comes from their PaymentPlan tier instead (PaymentPlanSvc).
 * Off (0) by default. A positive value still reinstates a cap for that tenant-less fallback only. */
const maxCasesPerAccountRaw = process.env.MAX_CASES_PER_ACCOUNT?.trim();
const maxCasesPerAccount = maxCasesPerAccountRaw ? Math.floor(Number(maxCasesPerAccountRaw)) : NaN;
export const MAX_CASES_PER_ACCOUNT = Number.isFinite(maxCasesPerAccount) && maxCasesPerAccount >= 0 ? maxCasesPerAccount : 0;
/** AccountLimitsSvc's fallback included AI allowance (USD, all providers, across every case) for a
 * LAWYER with no tenant at all (a legacy/edge case) — a tenant-scoped lawyer's allowance comes from
 * their PaymentPlan tier instead. A missing or invalid value uses 20; 0 turns the limit off
 * entirely for that tenant-less fallback only. */
const caseSpendLimitUsdRaw = process.env.CASE_SPEND_LIMIT_USD?.trim();
const caseSpendLimitUsd = caseSpendLimitUsdRaw ? Number(caseSpendLimitUsdRaw) : NaN;
export const CASE_SPEND_LIMIT_USD = Number.isFinite(caseSpendLimitUsd) && caseSpendLimitUsd >= 0 ? caseSpendLimitUsd : 20;
/** US dollars of AI usage bundled with the per-case fee, before an engagement needs a top-up
 * (#515, #516). A PLACEHOLDER until the price is signed off (FORHU/ilovelawyer-app#846). A missing
 * or invalid value uses 20. */
const engagementAiBudgetIncludedUsdRaw = process.env.ENGAGEMENT_AI_BUDGET_INCLUDED_USD?.trim();
const engagementAiBudgetIncludedUsd = engagementAiBudgetIncludedUsdRaw ? Number(engagementAiBudgetIncludedUsdRaw) : NaN;
export const ENGAGEMENT_AI_BUDGET_INCLUDED_USD =
  Number.isFinite(engagementAiBudgetIncludedUsd) && engagementAiBudgetIncludedUsd >= 0 ? engagementAiBudgetIncludedUsd : 20;
/** GBP per US dollar, for showing the engagement's AI budget (tracked internally in USD) to the
 * lawyer in GBP. A PLACEHOLDER rate until a real one is wired up (FORHU/ilovelawyer-app#846). A
 * missing or invalid value uses 0.8. */
/** US dollars of AI usage a single client case may spend on its Overview (ClientOverviewSvc) before
 * a Generate/Update is refused (B7, FORHU/ilovelawyer-app#572) — separate from CASE_SPEND_LIMIT_USD
 * above, which is a lawyer-account-wide allowance and never applies to USER accounts
 * (AccountLimitsSvc.allowanceInfo is a no-op for any role but LAWYER). A missing or invalid value
 * uses 2. */
const clientOverviewAiBudgetUsdRaw = process.env.CLIENT_OVERVIEW_AI_BUDGET_USD?.trim();
const clientOverviewAiBudgetUsd = clientOverviewAiBudgetUsdRaw ? Number(clientOverviewAiBudgetUsdRaw) : NaN;
export const CLIENT_OVERVIEW_AI_BUDGET_USD =
  Number.isFinite(clientOverviewAiBudgetUsd) && clientOverviewAiBudgetUsd >= 0 ? clientOverviewAiBudgetUsd : 2;
/** How many times a client may press Generate/Update on one case's Overview per UK calendar day
 * (D1) — counts both manual presses and the automatic first-document run. A missing or invalid
 * value uses 3. */
const clientOverviewDailyCapRaw = process.env.CLIENT_OVERVIEW_DAILY_CAP?.trim();
const clientOverviewDailyCap = clientOverviewDailyCapRaw ? Number(clientOverviewDailyCapRaw) : NaN;
export const CLIENT_OVERVIEW_DAILY_CAP =
  Number.isFinite(clientOverviewDailyCap) && clientOverviewDailyCap > 0 ? Math.floor(clientOverviewDailyCap) : 3;
/** US dollars of AI usage a single client case may spend on its Intake tab (ClientIntakeSvc)
 * before a manual Update is refused — separate from CLIENT_OVERVIEW_AI_BUDGET_USD so the two
 * jobs never contend for the same cap while both exist (the overview retires once the client
 * app ships the Intake tab). A missing or invalid value uses 2. */
const clientIntakeAiBudgetUsdRaw = process.env.CLIENT_INTAKE_AI_BUDGET_USD?.trim();
const clientIntakeAiBudgetUsd = clientIntakeAiBudgetUsdRaw ? Number(clientIntakeAiBudgetUsdRaw) : NaN;
export const CLIENT_INTAKE_AI_BUDGET_USD =
  Number.isFinite(clientIntakeAiBudgetUsd) && clientIntakeAiBudgetUsd >= 0 ? clientIntakeAiBudgetUsd : 2;
/** How many times a client may press Update on one case's Intake tab per UK calendar day.
 * Automatic runs (after a chat reply, a document going READY, or an edit to the case details)
 * don't count against this — only a client's own button press does. A missing or invalid value
 * uses 5. */
const clientIntakeDailyCapRaw = process.env.CLIENT_INTAKE_DAILY_CAP?.trim();
const clientIntakeDailyCap = clientIntakeDailyCapRaw ? Number(clientIntakeDailyCapRaw) : NaN;
export const CLIENT_INTAKE_DAILY_CAP =
  Number.isFinite(clientIntakeDailyCap) && clientIntakeDailyCap > 0 ? Math.floor(clientIntakeDailyCap) : 5;
/** Tags a client's own chat messages with the intake interviewer persona (INTAKE_TAG_UK, ADR
 * 0018) instead of the lawyer-research persona (LEGAL_TAG_UK) every chat turn gets today. Off
 * by default: chat-wonder-v2-api's `intake_uk` persona is a separate team's work
 * (docs/plans/intake-persona-contract.md) and this must stay off until it ships. Never affects a
 * lawyer's own chat, which is never tagged through this flag. */
export const CLIENT_INTAKE_PERSONA = process.env.CLIENT_INTAKE_PERSONA === "true";
const engagementAiBudgetGbpPerUsdRaw = process.env.ENGAGEMENT_AI_BUDGET_GBP_PER_USD?.trim();
const engagementAiBudgetGbpPerUsd = engagementAiBudgetGbpPerUsdRaw ? Number(engagementAiBudgetGbpPerUsdRaw) : NaN;
export const ENGAGEMENT_AI_BUDGET_GBP_PER_USD =
  Number.isFinite(engagementAiBudgetGbpPerUsd) && engagementAiBudgetGbpPerUsd > 0 ? engagementAiBudgetGbpPerUsd : 0.8;
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
/** The client app's origins (ilovelawyer-client, USER accounts), first one the default — e.g.
 * https://ilovelawyer.com,https://app.ilovelawyer.com, or http://localhost:3004 locally.
 * Links emailed to a client account open on one of these instead of the lawyer app — see
 * emailLinkOriginForAccount. Each must also be listed in CLIENT_URL so CORS lets it call the API. */
export const USER_APP_URL = (process.env.USER_APP_URL || "").split(",").map((origin) => origin.trim()).filter(Boolean);
/** Who's emailed when client requests expire unclaimed 48h after routing (#510): one digest per
 * sweep run, comma-separated. Unset, the expiry is only logged. */
export const OPS_ALERT_EMAILS = (process.env.OPS_ALERT_EMAILS || "").split(",").map((email) => email.trim()).filter(Boolean);
/** Who takes the client app's payments (payments/client-payment-provider.ts): "stripe", or "dummy"
 * (the default) which charges nothing. "stripe" needs STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY,
 * and STRIPE_WEBHOOK_SECRET for POST /api/webhooks/stripe. Use test-mode keys outside production. */
export const CLIENT_PAYMENT_PROVIDER = (process.env.CLIENT_PAYMENT_PROVIDER || "dummy").trim().toLowerCase();
/** Who saves a law firm's card on file (payments/organization-card-provider.ts): "stripe" (Stripe's
 * hosted card setup; needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET), or "dummy" (the default),
 * which saves a test card at once. Separate from CLIENT_PAYMENT_PROVIDER so each side can go live on
 * its own. */
export const LAWYER_PAYMENT_PROVIDER = (process.env.LAWYER_PAYMENT_PROVIDER || "dummy").trim().toLowerCase();
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || undefined;
/** Public by design: the client app needs it to show Stripe's payment form. */
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || undefined;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || undefined;
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID as string;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET as string;
/** Encrypts User.googleRefreshToken at rest (src/utils/google-token-crypto.ts): 32 bytes, as
 * base64 or 64 hex chars. Optional at boot so environments without Google Calendar still start;
 * connecting Google Calendar is refused while it's unset. */
export const GOOGLE_TOKEN_ENC_KEY = process.env.GOOGLE_TOKEN_ENC_KEY as string | undefined;
/** Field-level encryption of privileged text (src/utils/field-crypto.ts, issue #343). Off unless
 * FIELD_ENCRYPTION_ENABLED is "true". FIELD_ENCRYPTION_KEY is 32 bytes (base64 or 64 hex chars);
 * FIELD_ENCRYPTION_OLD_KEYS lists earlier keys, comma-separated, so values sealed with them still
 * open after a rotation. */
export const FIELD_ENCRYPTION_ENABLED = process.env.FIELD_ENCRYPTION_ENABLED === "true";
export const FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY as string | undefined;
export const FIELD_ENCRYPTION_OLD_KEYS = process.env.FIELD_ENCRYPTION_OLD_KEYS as string | undefined;
/** Field-level encryption of IntakeMessage.content/pendingReplyContent
 * (src/utils/intake-field-crypto.ts) — a deliberately separate key and implementation from
 * FIELD_ENCRYPTION_KEY above, so the client/intake pipeline shares nothing with the lawyer side
 * (see docs/adr, the 2026-10-28 intake-pipeline separation). Regionalised like
 * LEGAL_CHAT_MODEL_UK: one secret now, a _PH variant added when that region needs its own value. */
export const INTAKE_FIELD_ENCRYPTION_ENABLED = process.env.INTAKE_FIELD_ENCRYPTION_ENABLED === "true";
export const INTAKE_FIELD_ENCRYPTION_KEY_UK = process.env.INTAKE_FIELD_ENCRYPTION_KEY_UK as string | undefined;
export const INTAKE_FIELD_ENCRYPTION_OLD_KEYS_UK = process.env.INTAKE_FIELD_ENCRYPTION_OLD_KEYS_UK as string | undefined;
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
/** Key we send Chat Wonder as `x-api-key` to read its session-scoped trace stream (the AI Reasoning pane). The opposite
 * direction to CHAT_WONDER_API_KEY, so it gets its own secret; falls back to that key while a deployment has not set one,
 * so existing environments keep working. Must equal Chat Wonder's own TRACE_STREAM_API_KEY. */
export const TRACE_STREAM_API_KEY = process.env.TRACE_STREAM_API_KEY || CHAT_WONDER_API_KEY;
export const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY as string;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY as string;
export const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET as string;
export const AWS_REGION = process.env.AWS_REGION as string;
/** Region of AWS_S3_BUCKET, when it differs from AWS_REGION. A presigned URL is signed for one
 * specific region — sign for the wrong one and S3 rejects it outright. Textract reading a PDF
 * straight from the bucket (ocrPdfFromS3) must run in this region too. The UK stack
 * (ilovelawyer-uk) and Singapore each keep their bucket in their own region, so the two
 * normally match; verifyDocumentBucketRegion() warns at startup if the bucket is elsewhere.
 * Defaults to AWS_REGION, so single-region deployments need not set it. */
export const AWS_S3_REGION = process.env.AWS_S3_REGION || AWS_REGION;
/** Redirects the SQS client (only) at a local emulator (LocalStack) instead of real AWS — see
 * src/lib/sqs.ts. Left unset in production, which keeps talking to real AWS unchanged. Local
 * dev sets this to http://localhost:4566 (see .env.example) so each developer's own LocalStack
 * instance is the only thing their SQS traffic can ever reach — no shared AWS queue in dev. */
export const AWS_SQS_ENDPOINT = process.env.AWS_SQS_ENDPOINT || undefined;
// SQS queue URLs — one per background job type, provisioned externally (same convention as
// AWS_S3_BUCKET above: this app never creates its own AWS infra, only references it).
export const DOCUMENT_EXTRACTION_QUEUE_URL = process.env.DOCUMENT_EXTRACTION_QUEUE_URL as string;
/** Whether the API process also consumes DOCUMENT_EXTRACTION_QUEUE_URL (the default, as before).
 * Set to "false" when a separate extraction worker runs (src/extraction-worker.ts), so a large
 * upload's extraction memory can't take the API down. Trade-off: document:* socket events are
 * emitted from whichever process extracts, and socket.io rooms live only in the API process, so
 * with a separate worker the web app picks up status changes by polling instead of instantly. */
export const DOCUMENT_EXTRACTION_IN_API = process.env.DOCUMENT_EXTRACTION_IN_API !== "false";
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
/** The client app's chat turns (ilovelawyer-client) — the same worker code as the lawyer app's
 * chat, on its own queue so neither app's load holds up the other. See
 * queues/chat-generation.queue.ts. Must NOT share a physical SQS queue with
 * MESSAGE_PERSISTENCE_QUEUE_URL (or any other queue): two consumers polling one queue randomly
 * steal each other's messages. */
export const CLIENT_CHAT_GENERATION_QUEUE_URL = process.env.CLIENT_CHAT_GENERATION_QUEUE_URL as string;
/** The intake chat pipeline's own queue (IntakeMessage, caseId-keyed — see
 * queues/intake-chat-generation.queue.ts). Deliberately NOT the same worker code as
 * MESSAGE_PERSISTENCE_QUEUE_URL/CLIENT_CHAT_GENERATION_QUEUE_URL above — a fully separate queue,
 * processor and consumer per the 2026-10-28 intake-pipeline separation. Must NOT share a physical
 * SQS queue with any other queue in this file. */
export const INTAKE_CHAT_GENERATION_QUEUE_URL = process.env.INTAKE_CHAT_GENERATION_QUEUE_URL as string;
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
