import * as dotenv from "dotenv";
dotenv.config();

export const DATABASE_URL = process.env.DATABASE_URL as string;
export const PORT = Number(process.env.PORT || 3001);
export const SECRET_KEY = process.env.SECRET_KEY as string;
export const isDev = process.env.NODE_ENV !== "production";
export const SMTP_HOST = process.env.SMTP_HOST as string;
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = Number(process.env.SMTP_PORT || 587) === 465;
export const SMTP_USER = process.env.SMTP_USER as string;
export const SMTP_PASS = process.env.SMTP_PASS as string;
export const MAILER_FROM = (process.env.MAILER_FROM || process.env.SMTP_USER) as string;
export const MAILER_TRANSPORT_HOST = process.env.MAILER_TRANSPORT_HOST as string;
export const MAILER_TRANSPORT_PORT = Number(process.env.MAILER_TRANSPORT_PORT || 587);
export const MAILER_TRANSPORT_SECURE = process.env.MAILER_TRANSPORT_SECURE === "true";
export const MAILER_EMAIL = process.env.MAILER_EMAIL as string;
export const MAILER_PASSWORD = process.env.MAILER_PASSWORD as string;
export const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET as string;
export const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET as string;
export const ACCESS_TOKEN_EXPIRY = (process.env.ACCESS_TOKEN_EXPIRY || "1d") as string;
/** Day count used for cookies/DB. Env may be "30" or "30d". */
export const REFRESH_TOKEN_EXPIRY_DAYS = (() => {
    const raw = (process.env.REFRESH_TOKEN_EXPIRY_DAYS || "30d").trim();
    const days = Number(raw.replace(/d$/i, ""));
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
export const CHAT_WONDER_API_URL = process.env.CHAT_WONDER_API_URL as string;
export const CHAT_WONDER_WS_URL = process.env.CHAT_WONDER_WS_URL as string;
export const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY as string;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY as string;
export const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET as string;
export const AWS_REGION = process.env.AWS_REGION as string;
export const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL as string;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;
