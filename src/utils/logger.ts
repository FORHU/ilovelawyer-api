import winston from "winston";

const transports: winston.transport[] = [
  new winston.transports.Console(),
  new winston.transports.File({ filename: "error.log", level: "error" }),
  new winston.transports.File({ filename: "combined.log" }),
];

const logger = winston.createLogger({
  // LOG_LEVEL=debug surfaces the per-call hybrid-retrieval attribution (which chunks the lexical
  // channel appended) that benchmark runs need; anything else keeps production at info.
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    // JSON.stringify drops Error.message/stack (non-enumerable), so `logger.error("x", { err })`
    // was silently serializing errors to `{}`. Unwrap them wherever they appear, not just top-level.
    winston.format.json({
      replacer: (_key, value) => (value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value),
    }),
  ),
  transports,
});

export default logger;
