/** Adding an email from Gmail to a case (EPIC #982, #986/#987): the email PDF renderer and
 * GmailCaseImportSvc, against stubbed Gmail, case, S3 and audit seams. No live Google, S3 or DB. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { PDFParse } from "pdf-parse";
import GmailCaseImportSvc, { emailPdfName, isSupportedAttachment, safeFileName } from "../src/services/gmail-case-import.service";
import GmailMailboxSvc, { type GmailMessageView } from "../src/services/gmail-mailbox.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import SecurityAuditSvc from "../src/services/security-audit.service";
import AuthRepo from "../src/repositories/auth.repository";
import HttpError from "../src/utils/http-error";
import { emailBodyText, htmlToText, renderEmailPdf } from "../src/utils/email-pdf-renderer";

async function pdfText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

const MESSAGE: GmailMessageView = {
  id: "m1",
  threadId: "t1",
  from: "Ana Cruz <ana@example.com>",
  to: "client@gmail.com",
  cc: "friend@example.com",
  bcc: null,
  subject: "Deposit dispute: final notice",
  dateHeader: "Tue, 3 Mar 2026 09:15:00 +0000",
  date: "2026-03-03T09:15:00.000Z",
  messageIdHeader: "<abc@example.com>",
  snippet: "Please pay",
  textBody: null,
  htmlBody: '<html><head><style>p{color:red}</style></head><body><p>Please pay the <b>deposit</b>.</p><p><a href="https://pay.example.com/x">Pay here</a></p><ul><li>Rent</li><li>Damage</li></ul></body></html>',
  attachments: [
    { partId: "1", filename: "tenancy-agreement.pdf", mimeType: "application/pdf", size: 120000, inline: false },
    { partId: "2", filename: "photos.zip", mimeType: "application/zip", size: 5000, inline: false },
    { partId: "3", filename: "logo.png", mimeType: "image/png", size: 900, inline: true },
  ],
};

describe("Email PDF renderer", () => {
  it("turns an HTML body into readable text, keeping link targets and list items", () => {
    expect(htmlToText(MESSAGE.htmlBody!)).to.equal("Please pay the deposit.\n\nPay here (https://pay.example.com/x)\n\n- Rent\n- Damage");
  });

  it("prefers the plain-text body and falls back to the HTML one", () => {
    expect(emailBodyText("  Hello\r\n\r\n\r\n\r\nthere  ", "<p>ignored</p>")).to.equal("Hello\n\nthere");
    expect(emailBodyText(null, "<p>From HTML</p>")).to.equal("From HTML");
    expect(emailBodyText(null, null)).to.equal("");
  });

  it("prints the header block, Bcc as not available on received mail, the body and the attachment list", async () => {
    const pdf = await renderEmailPdf({
      ...MESSAGE,
      body: emailBodyText(MESSAGE.textBody, MESSAGE.htmlBody),
      attachments: [{ filename: "tenancy-agreement.pdf", size: 120000, addedToCase: true }],
      mailbox: "client@gmail.com",
      importedAt: new Date("2026-11-11T05:00:00Z"),
    });
    expect(pdf.subarray(0, 4).toString()).to.equal("%PDF");
    const text = await pdfText(pdf);
    for (const expected of [
      "Ana Cruz <ana@example.com>",
      "friend@example.com",
      "Not available (Gmail only keeps Bcc on mail you sent)",
      "Tue, 3 Mar 2026 09:15:00 +0000",
      "Please pay the deposit.",
      "tenancy-agreement.pdf (117.2 KB), added to this case as its own document",
      "Copied from Gmail (client@gmail.com) on 2026-11-11 05:00 UTC",
    ]) {
      expect(text).to.include(expected);
    }
  });
});

describe("Gmail case import naming", () => {
  it("names the email PDF by subject and day, without path characters", () => {
    expect(emailPdfName("Re: deposit / keys?", "2026-03-03T09:15:00.000Z")).to.equal("Email - Re deposit keys - 2026-03-03.pdf");
    expect(emailPdfName(null, null)).to.equal("Email - (no subject).pdf");
    expect(safeFileName("x".repeat(300), ".pdf")).to.have.length(124);
  });

  it("accepts only the file types a case upload accepts", () => {
    expect(isSupportedAttachment("tenancy-agreement.PDF")).to.equal(true);
    expect(isSupportedAttachment("photos.zip")).to.equal(false);
  });
});

describe("GmailCaseImportSvc", () => {
  const workspace = { id: "ws-1" } as ClientWorkspace;
  const realLoad = ClientCaseSvc.load;
  const realAdd = ClientCaseSvc.addDocument;
  const realGet = GmailMailboxSvc.getMessageWithAttachments;
  const realUpload = GmailCaseImportSvc.upload;
  const realRecord = SecurityAuditSvc.record;
  const realTokens = AuthRepo.findGmailTokens;

  let uploads: { key: string; size: number; contentType: string }[];
  let added: { name: string; key: string; contentType?: string }[];
  let audits: { action: string; targetId?: string | null; payload?: unknown }[];
  let requestedParts: string[] | null;
  let caseExists: boolean;

  beforeEach(() => {
    uploads = [];
    added = [];
    audits = [];
    requestedParts = null;
    caseExists = true;
    (ClientCaseSvc as any).load = async () => {
      if (!caseExists) throw new HttpError("Case not found", 404);
      return {};
    };
    (ClientCaseSvc as any).addDocument = async (_w: unknown, _u: string, _c: string, file: { key: string; name: string; contentType?: string }) => {
      added.push(file);
      return { id: `doc-${added.length}`, name: file.name, status: "PENDING" };
    };
    (GmailMailboxSvc as any).getMessageWithAttachments = async (_u: string, _id: string, partIds: string[]) => {
      requestedParts = partIds;
      const files = partIds.map((partId) => {
        const a = MESSAGE.attachments.find((x) => x.partId === partId)!;
        return { partId, buffer: Buffer.from(`bytes of ${a.filename}`), filename: a.filename, mimeType: a.mimeType };
      });
      return { message: MESSAGE, files };
    };
    (GmailCaseImportSvc as any).upload = async (key: string, body: Buffer, contentType: string) => {
      uploads.push({ key, size: body.length, contentType });
    };
    (SecurityAuditSvc as any).record = async (input: { action: string; targetId?: string | null; payload?: unknown }) => {
      audits.push(input);
    };
    (AuthRepo as any).findGmailTokens = async () => ({ gmailEmail: "client@gmail.com" });
  });

  afterEach(() => {
    (ClientCaseSvc as any).load = realLoad;
    (ClientCaseSvc as any).addDocument = realAdd;
    (GmailMailboxSvc as any).getMessageWithAttachments = realGet;
    (GmailCaseImportSvc as any).upload = realUpload;
    (SecurityAuditSvc as any).record = realRecord;
    (AuthRepo as any).findGmailTokens = realTokens;
  });

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

  it("adds the email as a PDF first, then each chosen attachment as its own document, and audits it", async () => {
    const result = await GmailCaseImportSvc.importToCase(workspace, "user-1", "case-1", { messageId: "m1", includeEmail: true, attachmentPartIds: ["1", "1"] });

    expect(requestedParts).to.deep.equal(["1"]);
    expect(added.map((d) => d.name)).to.deep.equal(["Email - Deposit dispute final notice - 2026-03-03.pdf", "tenancy-agreement.pdf"]);
    expect(added.map((d) => d.contentType)).to.deep.equal(["application/pdf", "application/pdf"]);
    expect(uploads.every((u) => /^documents\/cases\/case-1\/\d+-[0-9a-f]{8}\.pdf$/.test(u.key))).to.equal(true);
    expect(added.map((d) => d.key)).to.deep.equal(uploads.map((u) => u.key));
    expect(result.documents.map((d) => d.id)).to.deep.equal(["doc-1", "doc-2"]);
    expect(audits).to.have.length(1);
    expect(audits[0]).to.include({ action: "gmail.imported_to_case", targetId: "case-1" });
    expect(audits[0].payload).to.deep.include({ messageId: "m1", email: true, attachmentPartIds: ["1"], documentIds: ["doc-1", "doc-2"] });
  });

  it("adds only the attachments when the email itself isn't wanted", async () => {
    await GmailCaseImportSvc.importToCase(workspace, "user-1", "case-1", { messageId: "m1", includeEmail: false, attachmentPartIds: ["1"] });
    expect(added.map((d) => d.name)).to.deep.equal(["tenancy-agreement.pdf"]);
  });

  it("refuses an attachment type a case can't take, before saving anything", async () => {
    await expectError(
      GmailCaseImportSvc.importToCase(workspace, "user-1", "case-1", { messageId: "m1", includeEmail: true, attachmentPartIds: ["1", "2"] }),
      400,
      "GMAIL_ATTACHMENT_UNSUPPORTED",
    );
    expect(uploads).to.have.length(0);
    expect(added).to.have.length(0);
  });

  it("checks the case is the client's own before reading Gmail", async () => {
    caseExists = false;
    await expectError(GmailCaseImportSvc.importToCase(workspace, "user-1", "someone-elses", { messageId: "m1", includeEmail: true, attachmentPartIds: [] }), 404);
    expect(requestedParts).to.equal(null);
  });

  it("asks for something to add", async () => {
    await expectError(GmailCaseImportSvc.importToCase(workspace, "user-1", "case-1", { messageId: "m1", includeEmail: false, attachmentPartIds: [] }), 400);
    expect(requestedParts).to.equal(null);
  });
});
