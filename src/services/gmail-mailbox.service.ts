import GmailConnectionSvc from "./gmail-connection.service";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** How many messages.get calls run at once for one operation. Gmail allows 250 quota units per
 * user per second (each get costs 5), but it also refuses too many concurrent requests per user,
 * and a search, "Suggest by AI" and an open email can overlap; 5 keeps one user's bursts small. */
const GET_CONCURRENCY = 5;
export const GMAIL_SEARCH_MAX_LIMIT = 50;
/** Waits before each retry of a rate-limited request (Gmail's advice: exponential backoff). */
export const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000];
/** Longest wait a Retry-After header is honoured for; a longer one is answered as busy at once. */
const RETRY_AFTER_MAX_MS = 10_000;

/** How long to wait before retry `attempt` (0-based) of a rate-limited request: Gmail's
 * Retry-After (seconds or an HTTP date) when it sends one, else the backoff schedule. Null when
 * the retries are used up or Gmail asks for longer than RETRY_AFTER_MAX_MS. */
export function rateLimitDelayMs(retryAfter: string | null, attempt: number, schedule: number[] = RATE_LIMIT_BACKOFF_MS, now = Date.now()): number | null {
  if (attempt >= schedule.length) return null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return ms > RETRY_AFTER_MAX_MS ? null : Math.max(0, ms);
  }
  return schedule[attempt];
}
/** Inline images (`cid:` in the HTML) are embedded in the body up to these sizes. A bigger one is
 * left as a broken image in the body; it's still in the attachment list to download. */
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const INLINE_IMAGES_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

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

/** A `cid:` reference as it appears in HTML, up to the closing quote, bracket or space. */
const CID_REFERENCE = /cid:([^"'\s)>]+)/gi;

/** A Content-ID or `cid:` value in one comparable form: URL-decoded, without angle brackets, and
 * lowercased (mail clients disagree on case). */
function normalizeCid(id: string): string {
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    // keep it as written
  }
  return decoded.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** Every `cid:` the HTML refers to, normalized. */
export function cidReferencesOf(html: string): Set<string> {
  const refs = new Set<string>();
  for (const match of html.matchAll(CID_REFERENCE)) refs.add(normalizeCid(match[1]));
  return refs;
}

/** Only a plain image type may go into a data: URI, so nothing from the email can break out of
 * the attribute it's written into. */
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

/** The image parts the HTML shows inline, keyed by normalized Content-ID: parts with a
 * Content-ID that the HTML references as `cid:`. Such a part need not have a filename. */
export function inlineImagePartsOf(payload: GmailPart | undefined, html: string): Map<string, GmailPart> {
  const found = new Map<string, GmailPart>();
  const refs = cidReferencesOf(html);
  if (!payload || refs.size === 0) return found;
  walk(payload, (p) => {
    const contentId = header(p.headers, "Content-ID");
    if (!contentId || !IMAGE_MIME.test(p.mimeType ?? "")) return;
    const key = normalizeCid(contentId);
    if (refs.has(key) && !found.has(key)) found.set(key, p);
  });
  return found;
}

/** The HTML with each resolved `cid:` replaced by its data: URI. Unresolved ones are left as they
 * are and show as a broken image. */
export function replaceCidReferences(html: string, dataUris: Map<string, string>): string {
  if (dataUris.size === 0) return html;
  return html.replace(CID_REFERENCE, (match, id: string) => dataUris.get(normalizeCid(id)) ?? match);
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
  /** The backoff schedule gmailGet uses (a seam for the specs, which don't wait for real). */
  static backoffMs: number[] = RATE_LIMIT_BACKOFF_MS;

  /** A GET against the Gmail API as the user. Refreshes once on a 401 (expired token), backs off
   * and retries when rate-limited (see rateLimitDelayMs), and turns anything else into an error the
   * app can show. Only a refusal that means the grant is gone (a fresh token rejected, or Gmail no
   * longer in its scopes) clears the connection; a quota limit never does. */
  static async gmailGet<T>(userId: string, path: string, auth: GmailToken = new GmailToken(userId)): Promise<T> {
    let token = await auth.get();
    let refreshed = false;
    let retries = 0;

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
        const delay = rateLimitDelayMs(res.headers.get("Retry-After"), retries, GmailMailboxSvc.backoffMs);
        logger.warn("Gmail rate-limited a request", { userId, status: res.status, reasons: [...reasons], attempt: retries + 1, retryInMs: delay });
        if (delay !== null) {
          await sleep(delay);
          retries++;
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
    const messages = await GmailMailboxSvc.readRows(userId, (list.messages ?? []).map((m) => m.id), auth);

    await SecurityAuditSvc.record({
      action: "gmail.searched",
      actorId: userId,
      targetType: "integration",
      payload: { type: "gmail", resultCount: messages.length, page: input.pageToken ? "next" : "first" },
    });
    return { messages, nextPageToken: list.nextPageToken ?? null };
  }

  /** A search row (headers and attachment names, never body data) per id, in the same order. A
   * message deleted between the list and its read is dropped, not the whole batch. */
  private static async readRows(userId: string, ids: string[], auth: GmailToken): Promise<GmailSearchRow[]> {
    const fields = new URLSearchParams({ format: "full", fields: SEARCH_FIELDS });
    const rows = await mapPool(ids, GET_CONCURRENCY, (id) =>
      GmailMailboxSvc.gmailGet<GmailMessageResource>(userId, `/messages/${encodeURIComponent(id)}?${fields}`, auth).then(
        toSearchRow,
        (err: unknown) => {
          if (err instanceof HttpError && err.statusCode === 404) return null;
          throw err;
        },
      ),
    );
    return rows.filter((row): row is GmailSearchRow => row !== null);
  }

  /**
   * Candidates for "Suggest by AI" (#984): the messages matching any of `queries`, newest first.
   * One list call per query (`perQuery` ids each), ids merged without repeats, then one header
   * read per id, up to `max`. Ids found by more queries are kept first when there are too many.
   * Writes no audit event; the caller records the scan.
   */
  static async searchCandidates(userId: string, queries: string[], options: { perQuery: number; max: number }): Promise<GmailSearchRow[]> {
    const auth = new GmailToken(userId);
    const hits = new Map<string, number>();
    const lists = await mapPool(queries, 3, (q) =>
      GmailMailboxSvc.gmailGet<{ messages?: { id: string }[] }>(userId, `/messages?${new URLSearchParams({ q, maxResults: String(options.perQuery) })}`, auth),
    );
    for (const list of lists) for (const m of list.messages ?? []) hits.set(m.id, (hits.get(m.id) ?? 0) + 1);

    const ids = [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.max)
      .map(([id]) => id);
    const rows = await GmailMailboxSvc.readRows(userId, ids, auth);
    return rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
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

  /**
   * The HTML body with its inline images (`cid:` references) embedded as data: URIs, so they show
   * in the client's locked-down email frame, which loads nothing from outside. Images are fetched
   * in document order until the size limits are reached; one that fails to load or is too big is
   * left out, never failing the whole message.
   */
  private static async embedInlineImages(userId: string, messageId: string, payload: GmailPart | undefined, html: string, auth: GmailToken): Promise<string> {
    const parts = [...inlineImagePartsOf(payload, html)].filter(([, part]) => (part.body?.size ?? 0) <= INLINE_IMAGE_MAX_BYTES);
    if (parts.length === 0) return html;

    const fetched = await mapPool(parts, GET_CONCURRENCY, async ([cid, part]) => {
      try {
        const bytes = await GmailMailboxSvc.partBytes(userId, messageId, part, auth);
        return bytes && bytes.length <= INLINE_IMAGE_MAX_BYTES ? { cid, part, bytes } : null;
      } catch (err) {
        logger.warn("Couldn't embed an inline Gmail image", { userId, messageId, partId: part.partId, err });
        return null;
      }
    });

    const dataUris = new Map<string, string>();
    let total = 0;
    for (const image of fetched) {
      if (!image) continue;
      total += image.bytes.length;
      if (total > INLINE_IMAGES_MAX_TOTAL_BYTES) break;
      dataUris.set(image.cid, `data:${image.part.mimeType!.toLowerCase()};base64,${image.bytes.toString("base64")}`);
    }
    return replaceCidReferences(html, dataUris);
  }

  /** One message in full: headers, plain and HTML bodies (inline images embedded), and its
   * attachments (metadata only). */
  static async getMessage(userId: string, id: string): Promise<GmailMessageView> {
    const auth = new GmailToken(userId);
    const msg = await GmailMailboxSvc.getFull(userId, id, auth);
    return GmailMailboxSvc.toView(userId, msg, auth, { embedImages: true });
  }

  /** A message and the bytes of the chosen attachments, from one read of it (for adding an email
   * to a case, #986/#987). Inline images aren't embedded: the PDF made from it is text. Writes no
   * audit event; the caller records what it did with them. */
  static async getMessageWithAttachments(userId: string, id: string, partIds: string[]) {
    const auth = new GmailToken(userId);
    const msg = await GmailMailboxSvc.getFull(userId, id, auth);
    const [message, files] = await Promise.all([
      GmailMailboxSvc.toView(userId, msg, auth, { embedImages: false }),
      mapPool(partIds, GET_CONCURRENCY, (partId) => GmailMailboxSvc.readAttachment(userId, msg, partId, auth)),
    ]);
    return { message, files };
  }

  private static async toView(userId: string, msg: GmailMessageResource, auth: GmailToken, options: { embedImages: boolean }): Promise<GmailMessageView> {
    const headers = msg.payload?.headers;
    const { text, html } = bodyPartsOf(msg.payload);
    const [textBody, rawHtml] = await Promise.all([
      GmailMailboxSvc.partText(userId, msg.id, text, auth),
      GmailMailboxSvc.partText(userId, msg.id, html, auth),
    ]);
    const htmlBody =
      rawHtml && options.embedImages ? await GmailMailboxSvc.embedInlineImages(userId, msg.id, msg.payload, rawHtml, auth) : rawHtml;

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
    const { buffer, filename, mimeType } = await GmailMailboxSvc.readAttachment(userId, msg, partId, auth);
    await SecurityAuditSvc.record({
      action: "gmail.attachment_downloaded",
      actorId: userId,
      targetType: "integration",
      payload: { type: "gmail", messageId: msg.id, partId, mimeType, size: buffer.length },
    });
    return { buffer, filename, mimeType };
  }

  /** The file part `partId` of a message already read, with its current bytes. */
  private static async readAttachment(userId: string, msg: GmailMessageResource, partId: string, auth: GmailToken) {
    let part: GmailPart | undefined;
    if (msg.payload) walk(msg.payload, (p) => p.partId === partId && isAttachment(p) && (part = p));
    if (!part) throw new HttpError("That attachment couldn't be found.", 404, "GMAIL_NOT_FOUND");

    const buffer = await GmailMailboxSvc.partBytes(userId, msg.id, part, auth);
    if (!buffer) throw new HttpError("That attachment couldn't be read.", 502);
    return { partId, buffer, filename: part.filename!, mimeType: part.mimeType ?? "application/octet-stream" };
  }
}
