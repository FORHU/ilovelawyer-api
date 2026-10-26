/** Pure-function tests for ClientIntakeSvc's extraction half (src/utils/client-intake-extract.ts):
 * the reply parser resolves every cited handle against the real documents/messages this run was
 * built from, drops anything that doesn't resolve, drops a sourceless item, and requires at least
 * two surviving sources for a conflict. No DB, no Chat Wonder call. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { parseIntakeReply, buildIntakePrompt, caseDetailsPeople, type IntakeMessageInput } from "../src/utils/client-intake-extract";
import type { CaseDoc } from "../src/utils/case-document-handles";

const docs: CaseDoc[] = [
  { id: "doc-1", name: "Employment contract.pdf" },
  { id: "doc-2", name: "Dismissal letter.pdf" },
];

const messages: IntakeMessageInput[] = [
  { id: "msg-1", role: "user", text: "I was dismissed on 3 March 2026.", at: new Date("2026-03-04T09:00:00Z") },
  { id: "msg-2", role: "ai", text: "Thanks, can you tell me who dismissed you?", at: new Date("2026-03-04T09:01:00Z") },
  { id: "msg-3", role: "user", text: "My manager, Priya.", at: new Date("2026-03-04T09:02:00Z") },
];

function reply(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("Client intake extraction", () => {
  describe("parseIntakeReply", () => {
    it("resolves a document handle with a page, and a message handle, to their real ids", () => {
      const parsed = parseIntakeReply(
        reply({
          summary: "The client describes a dismissal.",
          facts: [{ text: "Dismissed on 3 March 2026.", sources: ["M1"] }],
          timeline: [{ text: "Dismissal", date: "2026-03-03", datePrecision: "DAY", sources: ["D2 p.1"] }],
        }),
        docs,
        messages,
      );
      expect(parsed).to.not.be.null;
      expect(parsed!.facts[0]!.sources).to.deep.equal([{ kind: "CLIENT", messageId: "msg-1", documentId: null, documentName: null, page: null }]);
      expect(parsed!.timeline[0]!.sources).to.deep.equal([{ kind: "DOCUMENT", messageId: null, documentId: "doc-2", documentName: "Dismissal letter.pdf", page: 1 }]);
    });

    it("drops a source that cites a handle outside this run's documents or messages", () => {
      // Both sources are unresolvable, so the fact is dropped — and with nothing else in the
      // reply, there's nothing usable left at all.
      const parsed = parseIntakeReply(reply({ facts: [{ text: "Something", sources: ["M99", "D9"] }] }), docs, messages);
      expect(parsed).to.be.null;

      // Alongside something else that does resolve, only the unresolvable fact is dropped.
      const withSummary = parseIntakeReply(reply({ summary: "ok", facts: [{ text: "Something", sources: ["M99", "D9"] }] }), docs, messages);
      expect(withSummary!.facts).to.have.length(0);
      expect(withSummary!.summary).to.equal("ok");
    });

    it("drops an item with no sources at all", () => {
      const parsed = parseIntakeReply(reply({ summary: "ok", goals: [{ text: "Get compensation", sources: [] }] }), docs, messages);
      expect(parsed!.goals).to.have.length(0);
    });

    it("keeps missing-information items with no sources, since none are ever sourced", () => {
      const parsed = parseIntakeReply(reply({ missing: [{ question: "What date was the written warning?", why: "Not mentioned yet" }] }), docs, messages);
      expect(parsed!.missing).to.have.length(1);
      expect(parsed!.missing[0]).to.deep.include({ question: "What date was the written warning?", why: "Not mentioned yet" });
    });

    it("requires at least two surviving sources for a conflict, dropping one left with only one", () => {
      const parsed = parseIntakeReply(
        reply({
          conflicts: [
            { description: "Two dates for the same dismissal", sources: ["M1", "D1 p.2"] },
            { description: "Single-sourced, not really a conflict", sources: ["M1", "M99"] },
          ],
        }),
        docs,
        messages,
      );
      expect(parsed!.conflicts).to.have.length(1);
      expect(parsed!.conflicts[0]!.sources).to.have.length(2);
    });

    it("drops a date that isn't a real calendar date, keeping the item with no date", () => {
      const parsed = parseIntakeReply(reply({ timeline: [{ text: "Some event", date: "not-a-date", sources: ["M1"] }] }), docs, messages);
      expect(parsed!.timeline[0]!.date).to.be.null;
      expect(parsed!.timeline[0]!.datePrecision).to.equal("UNKNOWN");
    });

    it("gives the same item the same id across two separate runs with the same text", () => {
      const first = parseIntakeReply(reply({ goals: [{ text: "Get my job back", sources: ["M1"] }] }), docs, messages);
      const second = parseIntakeReply(reply({ goals: [{ text: "Get my job back", sources: ["M3"] }] }), docs, messages);
      expect(first!.goals[0]!.id).to.equal(second!.goals[0]!.id);
    });

    it("returns null for a reply with no JSON object", () => {
      expect(parseIntakeReply("Sorry, I can't help with that.", docs, messages)).to.be.null;
    });

    it("returns null for a reply with nothing usable: no summary and every list empty", () => {
      expect(parseIntakeReply(reply({ summary: "", facts: [], goals: [] }), docs, messages)).to.be.null;
    });

    it("de-duplicates repeated sources on one item", () => {
      const parsed = parseIntakeReply(reply({ facts: [{ text: "Dismissed", sources: ["M1", "M1", "m1"] }] }), docs, messages);
      expect(parsed!.facts[0]!.sources).to.have.length(1);
    });
  });

  describe("caseDetailsPeople", () => {
    it("maps each case party to a name and role, in order", () => {
      expect(caseDetailsPeople([{ name: "Acme Ltd", designation: "Opposing party" }])).to.deep.equal([{ name: "Acme Ltd", role: "Opposing party" }]);
    });
  });

  describe("buildIntakePrompt", () => {
    it("tells the model it is not giving legal advice, and includes the conversation and document handles", () => {
      const prompt = buildIntakePrompt({
        caseDetails: { title: "Dismissal", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales", where: "Leeds", side: "CLAIMANT", notes: null },
        parties: [],
        messages,
        documents: docs,
        documentExcerpts: "",
        today: "2026-03-10",
      });
      expect(prompt).to.include("not giving legal advice");
      expect(prompt).to.include("M1 (2026-03-04, client): I was dismissed on 3 March 2026.");
      expect(prompt).to.include("D1: Employment contract.pdf");
    });
  });
});
