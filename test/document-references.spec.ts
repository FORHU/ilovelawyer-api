/**
 * File ids must never reach a user: utils/document-references.ts turns ids into names in an AI
 * answer and in Decision Records. Pure functions, no I/O.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import {
  GENERIC_DOCUMENT_LABEL,
  decisionRecordsNeedSanitizing,
  isUuidLike,
  quoteAppearsIn,
  redactDocumentIds,
  sanitizeDecisionRecords,
} from "../src/utils/document-references";
import { DecisionRecordItem, DecisionRecordsPayload } from "../src/utils/response-parser";

const DOC_A = { id: "b56af9c1-1119-4ebe-bca2-330bbf6ea759", name: "Letter before claim.pdf" };
const DOC_B = { id: "5dee588a-2398-4452-9f02-01e21b90bf93", name: "Response letter.docx" };
const OTHER_TENANT_ID = "11111111-2222-4333-8444-555555555555";

function record(over: Partial<DecisionRecordItem> = {}): DecisionRecordItem {
  return {
    anchor: "Prestbury denies liability.",
    conclusion: "Prestbury contests its liability.",
    rule: [],
    evidenceFor: [],
    evidenceAgainst: [],
    alternatives: [],
    weighting: "Significant but contested.",
    confidence: "high",
    wouldChangeIf: [],
    ...over,
  };
}

describe("isUuidLike", () => {
  it("recognises a uuid, with surrounding space, in any case", () => {
    expect(isUuidLike(DOC_A.id)).to.equal(true);
    expect(isUuidLike(`  ${DOC_A.id.toUpperCase()} `)).to.equal(true);
  });

  it("rejects file names, short codes, empty and non-strings", () => {
    for (const v of ["Letter before claim.pdf", "D01", "F1", "", "b56af9c1", 42, null, undefined]) {
      expect(isUuidLike(v)).to.equal(false);
    }
  });
});

describe("redactDocumentIds", () => {
  it("replaces a known id with the file name", () => {
    expect(redactDocumentIds(`See ${DOC_A.id} at clause 5.`, [DOC_A])).to.equal("See Letter before claim.pdf at clause 5.");
  });

  it("drops the (id: ...) fragment the grounding context used to teach the AI to echo, keeping the name", () => {
    const text = `Document "Letter before claim.pdf" (id: ${DOC_A.id}, page 3): the claim is £170,450.`;
    expect(redactDocumentIds(text, [DOC_A])).to.equal('Document "Letter before claim.pdf": the claim is £170,450.');
  });

  it("drops an (id: ...) fragment for a document it has no name for, instead of leaving the id", () => {
    const out = redactDocumentIds(`Exhibit (id: ${OTHER_TENANT_ID}) says so.`, [DOC_A]);
    expect(out).to.equal("Exhibit says so.");
    expect(out).to.not.include(OTHER_TENANT_ID);
  });

  it("replaces every occurrence, case-insensitively, for several documents", () => {
    const out = redactDocumentIds(`${DOC_A.id} and ${DOC_B.id.toUpperCase()} and ${DOC_A.id}`, [DOC_A, DOC_B]);
    expect(out).to.equal("Letter before claim.pdf and Response letter.docx and Letter before claim.pdf");
  });

  it("leaves other text, and other uuid-shaped strings that are not explicit file ids, alone", () => {
    const text = `Message ${OTHER_TENANT_ID} was sent on 12 January 2026.`;
    expect(redactDocumentIds(text, [DOC_A])).to.equal(text);
  });

  it("uses a generic label for a document that has no name", () => {
    expect(redactDocumentIds(`See ${DOC_A.id}.`, [{ id: DOC_A.id, name: "  " }])).to.equal(`See ${GENERIC_DOCUMENT_LABEL}.`);
  });

  it("returns empty text unchanged", () => {
    expect(redactDocumentIds("", [DOC_A])).to.equal("");
  });
});

describe("quoteAppearsIn", () => {
  const text = "Prestbury’s position is that the outage was caused by a failure at its third-party cloud-hosting provider.";

  it("matches ignoring case, spacing, curly quotes and dash variants", () => {
    expect(quoteAppearsIn("prestbury's   position is that the outage was caused", text)).to.equal(true);
    expect(quoteAppearsIn("third‑party cloud-hosting provider", "the third-party cloud-hosting provider failed")).to.equal(true);
  });

  it("does not match text that is not there", () => {
    expect(quoteAppearsIn("the outage was caused by Halcyon", text)).to.equal(false);
  });

  it("never counts a very short fragment as a verified quote", () => {
    expect(quoteAppearsIn("the", text)).to.equal(false);
  });
});

describe("sanitizeDecisionRecords", () => {
  it("shows the file name instead of the id in `doc`, and fills in docId (the exact case from the bug report: id label, docId null, unverified)", () => {
    const payload: DecisionRecordsPayload = {
      records: [
        record({
          evidenceFor: [{ doc: DOC_A.id, docId: null, pinpoint: "Clause 14.3", quote: "an exact sentence from the letter", verified: false }],
        }),
      ],
    };
    const out = sanitizeDecisionRecords(payload, [DOC_A, DOC_B]);
    const ev = out.records[0].evidenceFor[0];
    expect(ev.doc).to.equal("Letter before claim.pdf");
    expect(ev.docId).to.equal(DOC_A.id);
    expect(ev.pinpoint).to.equal("Clause 14.3");
    expect(ev.doc).to.not.equal(DOC_A.id);
  });

  it("re-checks the quote against the document's own text once the document is known, and upgrades verified", () => {
    const quote = "Halcyon says clause 5 required Prestbury to achieve a 98% next-day dispatch service level";
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceFor: [{ doc: DOC_A.id, docId: null, pinpoint: "s 2", quote, verified: false }] })],
    };
    const texts = new Map([[DOC_A.id, `Introduction. ${quote}. Further text.`]]);
    const out = sanitizeDecisionRecords(payload, [DOC_A], { texts });
    expect(out.records[0].evidenceFor[0].verified).to.equal(true);
  });

  it("keeps verified false when the quote is not in the document (a quote taken from the AI's own answer)", () => {
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceFor: [{ doc: DOC_A.id, docId: null, pinpoint: "", quote: "a sentence only the AI wrote", verified: false }] })],
    };
    const texts = new Map([[DOC_A.id, "Completely different document text about something else entirely."]]);
    const out = sanitizeDecisionRecords(payload, [DOC_A], { texts });
    expect(out.records[0].evidenceFor[0].verified).to.equal(false);
    expect(out.records[0].evidenceFor[0].doc).to.equal("Letter before claim.pdf");
  });

  it("never downgrades an item chat-wonder already verified", () => {
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceFor: [{ doc: "Letter before claim.pdf", docId: DOC_A.id, pinpoint: "", quote: "already checked upstream", verified: true }] })],
    };
    const out = sanitizeDecisionRecords(payload, [DOC_A], { texts: new Map([[DOC_A.id, "unrelated text"]]) });
    expect(out.records[0].evidenceFor[0].verified).to.equal(true);
  });

  it("does not resolve an id that is not one of the documents in scope: it becomes the generic label and gets no docId", () => {
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceAgainst: [{ doc: OTHER_TENANT_ID, docId: null, pinpoint: "", quote: null, verified: false }] })],
    };
    const out = sanitizeDecisionRecords(payload, [DOC_A]);
    const ev = out.records[0].evidenceAgainst[0];
    expect(ev.doc).to.equal(GENERIC_DOCUMENT_LABEL);
    expect(ev.docId).to.equal(null);
    expect(JSON.stringify(out)).to.not.include(OTHER_TENANT_ID);
  });

  it("leaves an evidence label that is already a file name alone", () => {
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceFor: [{ doc: "Response letter.docx", docId: DOC_B.id, pinpoint: "para 2", quote: null, verified: true }] })],
    };
    const out = sanitizeDecisionRecords(payload, [DOC_A, DOC_B]);
    expect(out.records[0].evidenceFor[0]).to.deep.equal(payload.records[0].evidenceFor[0]);
  });

  it("redacts an id the AI wrote into the free-text fields", () => {
    const payload: DecisionRecordsPayload = {
      records: [
        record({
          conclusion: `Per ${DOC_A.id} the cap applies.`,
          weighting: `${DOC_B.id} outweighs it.`,
          wouldChangeIf: [`${DOC_A.id} were amended`],
          alternatives: [{ position: `Read ${DOC_A.id} differently`, whyRejected: `See ${DOC_B.id}`, evidenceRef: null }],
        }),
      ],
    };
    const out = JSON.stringify(sanitizeDecisionRecords(payload, [DOC_A, DOC_B]));
    expect(out).to.not.include(DOC_A.id);
    expect(out).to.not.include(DOC_B.id);
    expect(out).to.include("Letter before claim.pdf");
  });

  it("does not mutate its input", () => {
    const payload: DecisionRecordsPayload = {
      records: [record({ evidenceFor: [{ doc: DOC_A.id, docId: null, pinpoint: "", quote: null, verified: false }] })],
    };
    sanitizeDecisionRecords(payload, [DOC_A]);
    expect(payload.records[0].evidenceFor[0].doc).to.equal(DOC_A.id);
  });
});

describe("decisionRecordsNeedSanitizing", () => {
  it("is true for an id label, or an unverified quote on a resolved document", () => {
    expect(decisionRecordsNeedSanitizing({ records: [{ evidenceFor: [{ doc: DOC_A.id }] }] })).to.equal(true);
    expect(decisionRecordsNeedSanitizing({ records: [{ evidenceAgainst: [{ doc: "x.pdf", docId: DOC_A.id, quote: "q", verified: false }] }] })).to.equal(true);
  });

  it("is false for clean records, so callers can skip the document lookup", () => {
    expect(decisionRecordsNeedSanitizing({ records: [{ evidenceFor: [{ doc: "x.pdf", docId: DOC_A.id, quote: "q", verified: true }] }] })).to.equal(false);
    expect(decisionRecordsNeedSanitizing({ records: [] })).to.equal(false);
    expect(decisionRecordsNeedSanitizing(null)).to.equal(false);
    expect(decisionRecordsNeedSanitizing({})).to.equal(false);
  });
});
