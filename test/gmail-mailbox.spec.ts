/** GmailMailboxSvc: reading the connected inbox for the client app's email import (EPIC #982,
 * #983). The MIME helpers are pure; the service is exercised against a stubbed global fetch and a
 * stubbed GmailConnectionSvc, with no live Google. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import GmailMailboxSvc, {
  attachmentsOf,
  bodyPartsOf,
  decodeBase64Url,
  decodeText,
  toSearchRow,
  type GmailPart,
} from "../src/services/gmail-mailbox.service";
import GmailConnectionSvc from "../src/services/gmail-connection.service";
import HttpError from "../src/utils/http-error";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** mixed > (alternative > text, related > (html, inline png)), pdf, and a forwarded message. */
const PAYLOAD: GmailPart = {
  partId: "",
  mimeType: "multipart/mixed",
  headers: [
    { name: "From", value: "Ana Cruz <ana@example.com>" },
    { name: "To", value: "client@gmail.com" },
    { name: "Cc", value: "friend@example.com" },
    { name: "Subject", value: "Deposit dispute" },
    { name: "Date", value: "Tue, 3 Mar 2026 09:15:00 +0000" },
    { name: "Message-ID", value: "<abc@example.com>" },
  ],
  parts: [
    {
      partId: "0",
      mimeType: "multipart/alternative",
      parts: [
        { partId: "0.0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=\"UTF-8\"" }], body: { data: b64url("Here’s what happened…") } },
        {
          partId: "0.1",
          mimeType: "multipart/related",
          parts: [
            { partId: "0.1.0", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=iso-8859-1" }], body: { data: b64url(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])) } },
            {
              partId: "0.1.1",
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-ID", value: "<logo>" }, { name: "Content-Disposition", value: "inline; filename=logo.png" }],
              body: { attachmentId: "att-logo", size: 1200 },
            },
          ],
        },
      ],
    },
    {
      partId: "1",
      mimeType: "application/pdf",
      filename: "tenancy-agreement.pdf",
      headers: [{ name: "Content-Disposition", value: "attachment; filename=\"tenancy-agreement.pdf\"" }],
      body: { attachmentId: "att-pdf", size: 120000 },
    },
    {
      partId: "2",
      mimeType: "message/rfc822",
      filename: "Landlord reply.eml",
      headers: [{ name: "Content-Disposition", value: "attachment" }],
      body: { attachmentId: "att-eml", size: 5000 },
    },
  ],
};

describe("Gmail MIME helpers", () => {
  it("decodes base64url with or without padding", () => {
    expect(decodeBase64Url(b64url("hello?>")).toString()).to.equal("hello?>");
    expect(decodeBase64Url(b64url("a")).toString()).to.equal("a");
  });

  it("decodes text in the part's charset and falls back to UTF-8 for an unknown one", () => {
    expect(decodeText(Buffer.from([0xe9]), "iso-8859-1")).to.equal("é");
    expect(decodeText(Buffer.from("ok"), "x-not-a-charset")).to.equal("ok");
  });

  it("lists every file part with its partId, flagging inline images", () => {
    expect(attachmentsOf(PAYLOAD)).to.deep.equal([
      { partId: "0.1.1", filename: "logo.png", mimeType: "image/png", size: 1200, inline: true },
      { partId: "1", filename: "tenancy-agreement.pdf", mimeType: "application/pdf", size: 120000, inline: false },
      { partId: "2", filename: "Landlord reply.eml", mimeType: "message/rfc822", size: 5000, inline: false },
    ]);
  });

  it("finds the plain and HTML bodies, never a file part", () => {
    const { text, html } = bodyPartsOf(PAYLOAD);
    expect(text?.partId).to.equal("0.0");
    expect(html?.partId).to.equal("0.1.0");
  });

  it("skips a root that is itself the file, since it has no partId to download it by", () => {
    const root: GmailPart = { partId: "", mimeType: "application/pdf", filename: "scan.pdf", body: { data: b64url("%PDF") } };
    expect(attachmentsOf(root)).to.deep.equal([]);
  });

  it("builds a search row from headers and attachment names", () => {
    const row = toSearchRow({ id: "m1", threadId: "t1", snippet: "Here’s what", internalDate: "1772529300000", payload: PAYLOAD });
    expect(row).to.deep.equal({
      id: "m1",
      threadId: "t1",
      from: "Ana Cruz <ana@example.com>",
      to: "client@gmail.com",
      subject: "Deposit dispute",
      date: new Date(1772529300000).toISOString(),
      snippet: "Here’s what",
      attachmentNames: ["logo.png", "tenancy-agreement.pdf", "Landlord reply.eml"],
    });
  });
});

describe("GmailMailboxSvc", () => {
  const realFetch = globalThis.fetch;
  const realStored = GmailConnectionSvc.storedAccessToken;
  const realRefresh = GmailConnectionSvc.refreshAccessToken;
  const realForget = GmailConnectionSvc.forget;
  let calls: { url: string; auth: string }[];
  let refreshes: number;
  let forgotten: number;
  let respond: (url: string, auth: string) => Response;

  beforeEach(() => {
    calls = [];
    refreshes = 0;
    forgotten = 0;
    (GmailConnectionSvc as any).forget = async () => {
      forgotten++;
      return new HttpError("Gmail needs to be reconnected", 409, "GMAIL_RECONNECT_REQUIRED");
    };
    (GmailConnectionSvc as any).storedAccessToken = async () => "stored-token";
    (GmailConnectionSvc as any).refreshAccessToken = async () => {
      refreshes++;
      return "fresh-token";
    };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      calls.push({ url: String(url), auth });
      return respond(String(url), auth);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (GmailConnectionSvc as any).storedAccessToken = realStored;
    (GmailConnectionSvc as any).refreshAccessToken = realRefresh;
    (GmailConnectionSvc as any).forget = realForget;
  });

  const gmailError = (status: number, reason: string) =>
    new Response(JSON.stringify({ error: { code: status, errors: [{ reason }] } }), { status });

  async function expectError(promise: Promise<unknown>, status: number, code?: string) {
    try {
      await promise;
    } catch (err) {
      expect((err as HttpError).statusCode).to.equal(status);
      if (code) expect((err as HttpError).code).to.equal(code);
      return;
    }
    throw new Error(`expected HttpError ${status}`);
  }

  const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });

  it("searches with the query and page token, then reads each hit without body data", async () => {
    respond = (url) => {
      if (url.includes("/messages?")) return ok({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" });
      const id = /messages\/(m\d)/.exec(url)![1];
      return ok({ id, threadId: `t-${id}`, snippet: id, payload: { headers: [{ name: "Subject", value: `S ${id}` }] } });
    };
    const result = await GmailMailboxSvc.search("user-1", { q: "from:ana@example.com has:attachment", pageToken: "p1", limit: 2 });

    const list = new URL(calls[0].url);
    expect(list.searchParams.get("q")).to.equal("from:ana@example.com has:attachment");
    expect(list.searchParams.get("pageToken")).to.equal("p1");
    expect(list.searchParams.get("maxResults")).to.equal("2");
    const get = new URL(calls[1].url);
    expect(get.searchParams.get("fields")).to.include("payload(headers");
    expect(get.searchParams.get("fields")).not.to.include("data");
    expect(result.messages.map((m) => m.subject)).to.deep.equal(["S m1", "S m2"]);
    expect(result.nextPageToken).to.equal("p2");
  });

  it("refreshes the token once on a 401 and retries", async () => {
    respond = (_url, auth) => (auth === "Bearer stored-token" ? new Response("", { status: 401 }) : ok({ messages: [] }));
    const result = await GmailMailboxSvc.search("user-1", {});
    expect(refreshes).to.equal(1);
    expect(calls.map((c) => c.auth)).to.deep.equal(["Bearer stored-token", "Bearer fresh-token"]);
    expect(result.messages).to.deep.equal([]);
  });

  it("forgets the grant and asks for a reconnect when Google still refuses after a refresh", async () => {
    respond = () => new Response("", { status: 401 });
    await expectError(GmailMailboxSvc.search("user-1", {}), 409, "GMAIL_RECONNECT_REQUIRED");
    expect(forgotten).to.equal(1);
  });

  it("shares one refresh between the reads of a page when the token expires mid-search", async () => {
    respond = (url, auth) => {
      if (url.includes("/messages?")) return ok({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
      if (auth === "Bearer stored-token") return new Response("", { status: 401 });
      const id = /messages\/(m\d)/.exec(url)![1];
      return ok({ id, threadId: id, payload: { headers: [] } });
    };
    const result = await GmailMailboxSvc.search("user-1", {});
    expect(refreshes).to.equal(1);
    expect(result.messages).to.have.length(3);
  });

  it("drops a message deleted between the list and its read instead of failing the page", async () => {
    respond = (url) => {
      if (url.includes("/messages?")) return ok({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.includes("/messages/m1")) return new Response("", { status: 404 });
      return ok({ id: "m2", threadId: "t2", payload: { headers: [{ name: "Subject", value: "Kept" }] } });
    };
    const result = await GmailMailboxSvc.search("user-1", {});
    expect(result.messages.map((m) => m.subject)).to.deep.equal(["Kept"]);
  });

  it("treats a 403 quota limit as busy, never as a lost connection", async () => {
    respond = () => gmailError(403, "userRateLimitExceeded");
    await expectError(GmailMailboxSvc.getMessage("user-1", "m1"), 429, "GMAIL_RATE_LIMITED");
    expect(calls).to.have.length(2);
    expect(forgotten).to.equal(0);
  });

  it("forgets the grant when Gmail is no longer in its scopes", async () => {
    respond = () => gmailError(403, "insufficientPermissions");
    await expectError(GmailMailboxSvc.getMessage("user-1", "m1"), 409, "GMAIL_RECONNECT_REQUIRED");
    expect(forgotten).to.equal(1);
  });

  it("answers 503 without touching the connection when the Gmail API is off in the project", async () => {
    respond = () => gmailError(403, "accessNotConfigured");
    await expectError(GmailMailboxSvc.getMessage("user-1", "m1"), 503, "GMAIL_UNAVAILABLE");
    expect(forgotten).to.equal(0);
  });

  it("reads one message with Bcc absent on received mail and decoded bodies", async () => {
    respond = () => ok({ id: "m1", threadId: "t1", internalDate: "1772529300000", payload: PAYLOAD });
    const msg = await GmailMailboxSvc.getMessage("user-1", "m1");
    expect(msg.from).to.equal("Ana Cruz <ana@example.com>");
    expect(msg.cc).to.equal("friend@example.com");
    expect(msg.bcc).to.equal(null);
    expect(msg.textBody).to.equal("Here’s what happened…");
    expect(msg.htmlBody).to.equal("<p>é</p>");
    expect(msg.attachments).to.have.length(3);
  });

  it("downloads an attachment by partId using the current attachmentId and Gmail's own filename", async () => {
    respond = (url) => {
      if (url.includes("/attachments/")) return ok({ data: b64url("%PDF-1.7") });
      return ok({ id: "m1", threadId: "t1", payload: PAYLOAD });
    };
    const file = await GmailMailboxSvc.getAttachment("user-1", "m1", "1");
    expect(calls[1].url).to.match(/\/messages\/m1\/attachments\/att-pdf$/);
    expect(file.filename).to.equal("tenancy-agreement.pdf");
    expect(file.mimeType).to.equal("application/pdf");
    expect(file.buffer.toString()).to.equal("%PDF-1.7");
  });

  it("answers 404 for a partId that isn't a file on the message", async () => {
    respond = () => ok({ id: "m1", threadId: "t1", payload: PAYLOAD });
    try {
      await GmailMailboxSvc.getAttachment("user-1", "m1", "0.0");
      throw new Error("expected an error");
    } catch (err) {
      expect((err as HttpError).statusCode).to.equal(404);
    }
  });
});
