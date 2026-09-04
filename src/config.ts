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
/** Shared secret Chat Wonder sends back to us via `x-api-key` when it calls our API (e.g. to fetch case document chunks). */
export const CHAT_WONDER_API_KEY = process.env.CHAT_WONDER_API_KEY as string;
export const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY as string;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY as string;
export const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET as string;
export const AWS_REGION = process.env.AWS_REGION as string;
export const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL as string;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
export const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL as string;
export const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD as string;
/** Defaults to relying on PATH (works in the Docker image — `apk add ffmpeg` puts it there).
 * Override locally when a fresh install's PATH change hasn't propagated to the running shell
 * yet (a Windows/winget quirk, not something restarting nodemon alone fixes) — point this at
 * the binary directly instead. */
export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
