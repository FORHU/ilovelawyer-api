import GmailConnectionSvc from "./gmail-connection.service";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** How many messages.get calls run at once for one search page. Gmail allows 250 quota units per
 * user per second and each get costs 5, so 10 in flight stays well under it. */
const GET_CONCURRENCY = 10;
export const GMAIL_SEARCH_MAX_LIMIT = 50;
const RATE_LIMIT_RETRY_MS = 1000;

/** The part of the MIME tree a search row needs: headers and attachment filenames, never body
 * data (Gmail's partial-response `fields`). Three levels of nesting covers mixed > alternative >
 * related, which is as deep as ordinary mail goes; deeper attachments are only missed in the
 * search hint, not in getMessage. */
const SEARCH_FIELDS =
  "id,threadId,snippet,internalDate,payload(headers(name,value),filename,parts(filename,parts(filename,parts(filename))))";

interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessageResource {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailSearchRow {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  /** When Gmail received it (ISO), which is what Gmail sorts and filters by. */
  date: string | null;
  snippet: string;
  attachmentNames: string[];
}

export interface GmailAttachmentInfo {
  /** Stable for the life of the message, unlike Gmail's attachmentId, which changes on every
   * read. The download route takes this. */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Shown inside the body (a pasted image, a signature logo) rather than attached as a file. */
  inline: boolean;
}

export interface GmailMessageView {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  /** Only present on mail the user sent; Gmail never has Bcc for received mail. */
  bcc: string | null;
  subject: string | null;
  /** The Date header as sent. */
  dateHeader: string | null;
  date: string | null;
  messageIdHeader: string | null;
  snippet: string;
  textBody: string | null;
  htmlBody: string | null;
  attachments: GmailAttachmentInfo[];
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function header(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

function charsetOf(part: GmailPart): string {
  const contentType = header(part.headers, "Content-Type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}

/** Text in the part's declared charset, falling back to UTF-8 for one Node can't decode. */
export function decodeText(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function walk(part: GmailPart, visit: (p: GmailPart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function isAttachment(part: GmailPart): boolean {
  return !!part.filename;
}

function isInline(part: GmailPart): boolean {
  const disposition = header(part.headers, "Content-Disposition")?.toLowerCase() ?? "";
  if (disposition.startsWith("attachment")) return false;
  return disposition.startsWith("inline") || !!header(part.headers, "Content-ID");
}

/** Attachment filenames anywhere in the (search-trimmed) tree. */
export function attachmentNamesOf(payload: GmailPart | undefined): string[] {
  const names: string[] = [];
  if (payload) walk(payload, (p) => p.filename && names.push(p.filename));
  return names;
}

/** Every file part, with its stable partId. The root has no usable partId (Gmail gives it "" or
 * none), so a message whose root is itself the file is skipped: it couldn't be downloaded again. */
export function attachmentsOf(payload: GmailPart | undefined): GmailAttachmentInfo[] {
  const out: GmailAttachmentInfo[] = [];
  if (!payload) return out;
  walk(payload, (p) => {
    if (!isAttachment(p) || !p.partId) return;
    out.push({
      partId: p.partId,
      filename: p.filename!,
      mimeType: p.mimeType ?? "application/octet-stream",
      size: p.body?.size ?? 0,
      inline: isInline(p),
    });
  });
  return out;
}

/** The first text/plain and text/html parts that aren't files. For a very large body Gmail moves
 * the content out to an attachmentId; partText fetches it then. */
export function bodyPartsOf(payload: GmailPart | undefined): { text: GmailPart | null; html: GmailPart | null } {
  let text: GmailPart | null = null;
  let html: GmailPart | null = null;
  if (payload) {
    walk(payload, (p) => {
      if (isAttachment(p)) return;
      if (p.mimeType === "text/plain" && !text) text = p;
      if (p.mimeType === "text/html" && !html) html = p;
    });
  }
  return { text, html };
}

function isoFromInternalDate(internalDate: string | undefined): string | null {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export function toSearchRow(msg: GmailMessageResource): GmailSearchRow {
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    date: isoFromInternalDate(msg.internalDate),
    snippet: msg.snippet ?? "",
    attachmentNames: attachmentNamesOf(msg.payload),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gmail's error reasons (`error.errors[].reason`, `error.details[].reason`, `error.status`). */
async function errorReasons(res: Response): Promise<Set<string>> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
  };
  const reasons = [body.error?.status, ...(body.error?.errors ?? []).map((e) => e.reason), ...(body.error?.details ?? []).map((d) => d.reason)];
  return new Set(reasons.filter((r): r is string => !!r));
}

/** A 403 that only means "slow down": per-user rate or daily quota. Not a lost grant. */
const QUOTA_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"];
/** A 403 meaning the grant no longer covers Gmail (scope removed at Google). */
const SCOPE_REASONS = ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "authError"];
/** A 403 meaning the Gmail API is off in our Google Cloud project: a server problem, not the user's. */
const API_DISABLED_REASONS = ["accessNotConfigured", "SERVICE_DISABLED"];

const hasAny = (reasons: Set<string>, list: string[]) => list.some((r) => reasons.has(r));

/**
 * One operation's access token (a search page, a message read, a download): read from the database
 * once and shared by every Gmail call in it. When the token expires mid-operation, the calls that
 * get a 401 share a single refresh instead of each minting their own.
 */
export class GmailToken {
  private current: Promise<string> | null = null;
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(private readonly userId: string) {}

  get(): Promise<string> {
    this.current ??= GmailConnectionSvc.storedAccessToken(this.userId).then(
      (stored) => stored ?? GmailConnectionSvc.refreshAccessToken(this.userId),
    );
    return this.current;
  }

  /** A token to use instead of `stale`, which Gmail just rejected. The first caller with that
   * token mints a new one; the rest wait for it. */
  refresh(stale: string): Promise<string> {
    let next = this.refreshes.get(stale);
    if (!next) {
      next = GmailConnectionSvc.refreshAccessToken(this.userId);
      this.refreshes.set(stale, next);
      this.current = next;
    }
    return next;
  }
}

/** Read-only access to the connected Gmail inbox for the client app's email import. Nothing read
 * here is stored: search rows, bodies and attachments go straight back to the client. Saving an
 * email to a case is a separate, explicit step (later sub-issues of #982). */
export default class GmailMailboxSvc {
  /** A GET against the Gmail API as the user. Refreshes once on a 401 (expired token), waits once
   * when rate-limited, and turns anything else into an error the app can show. Only a refusal that
   * means the grant is gone (a fresh token rejected, or Gmail no longer in its scopes) clears the
   * connection; a quota limit never does. */
  static async gmailGet<T>(userId: string, path: string, auth: GmailToken = new GmailToken(userId)): Promise<T> {
    let token = await auth.get();
    let refreshed = false;
    let waited = false;

    for (;;) {
      const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401) {
        if (!refreshed) {
          token = await auth.refresh(token);
          refreshed = true;
          continue;
        }
        throw await GmailConnectionSvc.forget(userId);
      }
      if (res.status === 404) throw new HttpError("That email couldn't be found. It may have been deleted.", 404, "GMAIL_NOT_FOUND");

      const reasons = res.status === 403 ? await errorReasons(res) : new Set<string>();
      if (res.status === 429 || hasAny(reasons, QUOTA_REASONS)) {
        if (!waited) {
          await sleep(RATE_LIMIT_RETRY_MS);
          waited = true;
          continue;
        }
        throw new HttpError("Gmail is busy right now. Try again in a minute.", 429, "GMAIL_RATE_LIMITED");
      }
      if (hasAny(reasons, SCOPE_REASONS)) throw await GmailConnectionSvc.forget(userId);
      if (hasAny(reasons, API_DISABLED_REASONS)) {
        logger.error("Gmail API is disabled in the Google Cloud project", { userId });
        throw new HttpError("Gmail import isn't available right now.", 503, "GMAIL_UNAVAILABLE");
      }
      logger.warn("Gmail API request failed", { userId, status: res.status, reasons: [...reasons] });
      throw new HttpError("Couldn't reach Gmail. Try again shortly.", 502);
    }
  }

  /** One page of the inbox matching `q` (Gmail search syntax, as typed in Gmail's search box),
   * newest first. Spam and Trash are left out, as in Gmail. */
  static async search(userId: string, input: { q?: string; pageToken?: string; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), GMAIL_SEARCH_MAX_LIMIT);
    const params = new URLSearchParams({ maxResults: String(limit) });
    if (input.q?.trim()) params.set("q", input.q.trim());
    if (input.pageToken) params.set("pageToken", input.pageToken);

    const auth = new GmailToken(userId);
    const list = await GmailMailboxSvc.gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
      userId,
      `/messages?${params}`,
      auth,
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const fields = new URLSearchParams({ format: "full", fields: SEARCH_FIELDS });
    // A message deleted between the list and its read is dropped, not the whole page.
    const rows = await mapPool(ids, GET_CONCURRENCY, (id) =>
      GmailMailboxSvc.gmailGet<GmailMessageResource>(userId, `/messages/${encodeURIComponent(id)}?${fields}`, auth).then(
        toSearchRow,
        (err: unknown) => {
          if (err instanceof HttpError && err.statusCode === 404) return null;
          throw err;
        },
      ),
    );
    const messages = rows.filter((row): row is GmailSearchRow => row !== null);

    await SecurityAuditSvc.record({
      action: "gmail.searched",
      actorId: userId,
      targetType: "integration",
      payload: { type: "gmail", resultCount: messages.length, page: input.pageToken ? "next" : "first" },
    });
    return { messages, nextPageToken: list.nextPageToken ?? null };
  }

  private static async getFull(userId: string, id: string, auth: GmailToken): Promise<GmailMessageResource> {
    return GmailMailboxSvc.gmailGet<GmailMessageResource>(userId, `/messages/${encodeURIComponent(id)}?format=full`, auth);
  }

  /** A part's raw bytes: inline in the message when small, otherwise fetched by its attachmentId
   * (which Gmail also uses for a very large body). */
  private static async partBytes(userId: string, messageId: string, part: GmailPart, auth: GmailToken): Promise<Buffer | null> {
    let data = part.body?.data;
    if (!data && part.body?.attachmentId) {
      const fetched = await GmailMailboxSvc.gmailGet<{ data?: string }>(
        userId,
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        auth,
      );
      data = fetched.data;
    }
    return data ? decodeBase64Url(data) : null;
  }

  private static async partText(userId: string, messageId: string, part: GmailPart | null, auth: GmailToken): Promise<string | null> {
    if (!part) return null;
    const bytes = await GmailMailboxSvc.partBytes(userId, messageId, part, auth);
    return bytes ? decodeText(bytes, charsetOf(part)) : null;
  }

  /** One message in full: headers, plain and HTML bodies, and its attachments (metadata only). */
  static async getMessage(userId: string, id: string): Promise<GmailMessageView> {
    const auth = new GmailToken(userId);
    const msg = await GmailMailboxSvc.getFull(userId, id, auth);
    const headers = msg.payload?.headers;
    const { text, html } = bodyPartsOf(msg.payload);
    const [textBody, htmlBody] = await Promise.all([
      GmailMailboxSvc.partText(userId, msg.id, text, auth),
      GmailMailboxSvc.partText(userId, msg.id, html, auth),
    ]);

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: header(headers, "From"),
      to: header(headers, "To"),
      cc: header(headers, "Cc"),
      bcc: header(headers, "Bcc"),
      subject: header(headers, "Subject"),
      dateHeader: header(headers, "Date"),
      date: isoFromInternalDate(msg.internalDate),
      messageIdHeader: header(headers, "Message-ID"),
      snippet: msg.snippet ?? "",
      textBody,
      htmlBody,
      attachments: attachmentsOf(msg.payload),
    };
  }

  /** One attachment's bytes. The part is looked up again on a fresh read of the message, so the
   * filename and type come from Gmail, never from the request, and the current attachmentId is
   * used (Gmail issues a new one on every read). */
  static async getAttachment(userId: string, messageId: string, partId: string) {
    const auth = new GmailToken(userId);
    const msg = await GmailMailboxSvc.getFull(userId, messageId, auth);
    let part: GmailPart | undefined;
    if (msg.payload) walk(msg.payload, (p) => p.partId === partId && isAttachment(p) && (part = p));
    if (!part) throw new HttpError("That attachment couldn't be found.", 404, "GMAIL_NOT_FOUND");

    const buffer = await GmailMailboxSvc.partBytes(userId, msg.id, part, auth);
    if (!buffer) throw new HttpError("That attachment couldn't be read.", 502);

    const mimeType = part.mimeType ?? "application/octet-stream";
    await SecurityAuditSvc.record({
      action: "gmail.attachment_downloaded",
      actorId: userId,
      targetType: "integration",
      payload: { type: "gmail", messageId: msg.id, partId, mimeType, size: buffer.length },
    });
    return { buffer, filename: part.filename!, mimeType };
  }
}
