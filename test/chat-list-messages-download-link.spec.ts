/** ChatSvc.listMessages — the download link for a generated document. chat-wonder has the model
 * write `[affidavit of loss](#download)`; the real (expiring) presigned URL is swapped in at read
 * time so the stored message never carries it. ChatRepo and the s3 util are monkeypatched on their
 * CommonJS module objects, same idiom as test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import * as s3 from "../src/utils/s3";

const FILE = { id: "file-1", s3Key: "generated-documents/abc.pdf", filename: "Affidavit-of-Loss.pdf" };
const GENERATED = { documentType: "affidavit_of_loss", documentName: "Affidavit of Loss", file: FILE };

function message(content: string, generatedDocument: unknown) {
  return { id: "m1", role: "assistant", content, documents: [], generatedDocument };
}

describe("ChatSvc.listMessages — generated document download link", () => {
  const originals = {
    findConsultation: ChatRepo.findConsultationById,
    listMessages: ChatRepo.listMessagesByConsultation,
    presign: s3.getPresignedGetUrl,
  };
  let messages: any[];
  let presignCalls: { key: string; expiresIn?: number; downloadFilename?: string }[];

  beforeEach(() => {
    messages = [];
    presignCalls = [];
    (ChatRepo as any).findConsultationById = async () => ({ id: "c1", organizationId: "org-1" });
    (ChatRepo as any).listMessagesByConsultation = async () => messages;
    (s3 as any).getPresignedGetUrl = async (key: string, expiresIn?: number, downloadFilename?: string) => {
      presignCalls.push({ key, expiresIn, downloadFilename });
      return `https://s3.example/presigned/${key}`;
    };
  });

  afterEach(() => {
    (ChatRepo as any).findConsultationById = originals.findConsultation;
    (ChatRepo as any).listMessagesByConsultation = originals.listMessages;
    (s3 as any).getPresignedGetUrl = originals.presign;
  });

  it("replaces the (#download) placeholder the model wrote with the presigned URL", async () => {
    messages = [message("Here is your [affidavit of loss](#download). Please review it.", GENERATED)];
    const [m] = await ChatSvc.listMessages("org-1", "c1");
    expect(m!.content).to.equal(
      "Here is your [affidavit of loss](https://s3.example/presigned/generated-documents/abc.pdf). Please review it.",
    );
  });

  it("asks S3 to name the download after the document, not the UUID key", async () => {
    messages = [message("Here is your [affidavit](#download).", GENERATED)];
    await ChatSvc.listMessages("org-1", "c1");
    expect(presignCalls).to.deep.equal([
      { key: "generated-documents/abc.pdf", expiresIn: undefined, downloadFilename: "Affidavit-of-Loss.pdf" },
    ]);
  });

  it("appends a Download line when the model did not write a link", async () => {
    messages = [message("Your document is ready.", GENERATED)];
    const [m] = await ChatSvc.listMessages("org-1", "c1");
    expect(m!.content).to.equal(
      "Your document is ready.\n\n[Download Affidavit of Loss (pdf)](https://s3.example/presigned/generated-documents/abc.pdf)",
    );
  });

  it("leaves a message with no generated document untouched and never presigns", async () => {
    messages = [message("Plain answer, mentions (#download) in passing.", null)];
    const [m] = await ChatSvc.listMessages("org-1", "c1");
    expect(m!.content).to.equal("Plain answer, mentions (#download) in passing.");
    expect(presignCalls).to.have.length(0);
  });

  it("does not leak the raw generatedDocument relation (S3 key) into the response", async () => {
    messages = [message("Here is your [document](#download).", GENERATED)];
    const [m] = await ChatSvc.listMessages("org-1", "c1");
    expect(m).to.not.have.property("generatedDocument");
    expect(JSON.stringify(m)).to.not.include("s3Key");
  });
});
