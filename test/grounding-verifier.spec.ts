import { expect } from "chai";
import { describe, it } from "mocha";
import GroundingVerifierSvc, { extractPassage } from "../src/services/grounding-verifier.service";

describe("grounding verifier — passage resolution", () => {
  const doc = [
    "EXHIBIT D13 — ACCESS CONTROL, CCTV AND COVERT MONITORING",
    "",
    "Part 1. Badge records for the east gate between 06:00 and 08:00.",
    "Part 2. EXIF data recovered from the photograph. The examiner cautions that this does not establish the image was present on the handset.",
    "Part 3. CCTV retention policy is 14 days. Cameras 3, 4 and 7 were not produced.",
    "Part 4. Covert monitoring of the welfare cabin was ordered on 27 November and installed on 1 December 2023. No notice was given and no DPIA was carried out.",
  ].join("\n");

  it("returns the window around the cited part, not the head of the document", () => {
    const { passage, located } = extractPassage(doc, "Part 4");
    expect(located).to.equal(true);
    expect(passage).to.include("installed on 1 December 2023");
  });

  it("finds a decimal locator such as 'item 10.6'", () => {
    const d = "Disclosure note.\nitem 10.5 — draft memo.\nitem 10.6 — privileged note, return demanded 11 April 2024.";
    const { passage, located } = extractPassage(d, "item 10.6");
    expect(located).to.equal(true);
    expect(passage).to.include("return demanded 11 April 2024");
  });

  it("falls back to the head of the document and says so, rather than pretending it resolved", () => {
    // A merged bundle upload has no exhibit boundaries at all — the plan calls this out, and the
    // flag is stored so a verdict reached this way can be weighed accordingly.
    const { passage, located } = extractPassage(doc, "Part 99");
    expect(located).to.equal(false);
    expect(passage.startsWith("EXHIBIT D13")).to.equal(true);
  });

  it("handles a missing locator and empty text without throwing", () => {
    expect(extractPassage(doc, undefined).located).to.equal(false);
    expect(extractPassage("", "Part 1")).to.deep.equal({ passage: "", located: false });
  });

  it("respects the passage budget so one long exhibit can't blow up the Jev call", () => {
    const long = "x".repeat(20000);
    expect(extractPassage(long, undefined, 500).passage).to.have.length(500);
  });
});

describe("grounding verifier — safety contract", () => {
  it("is disabled unless USE_GROUNDING_VERIFIER is explicitly true", () => {
    const previous = process.env.USE_GROUNDING_VERIFIER;
    try {
      delete process.env.USE_GROUNDING_VERIFIER;
      expect(GroundingVerifierSvc.enabled).to.equal(false);
      process.env.USE_GROUNDING_VERIFIER = "false";
      expect(GroundingVerifierSvc.enabled).to.equal(false);
      process.env.USE_GROUNDING_VERIFIER = "true";
      expect(GroundingVerifierSvc.enabled, "read per call, so a later env change takes effect").to.equal(true);
    } finally {
      if (previous === undefined) delete process.env.USE_GROUNDING_VERIFIER;
      else process.env.USE_GROUNDING_VERIFIER = previous;
    }
  });

  it("returns empty counts and touches nothing when disabled", async () => {
    const counts = await GroundingVerifierSvc.verifyAnswer({
      assistantMessageId: "msg-1",
      caseId: "case-1",
      answer: "D13 Part 4 is not reproduced in the material presently available.",
      rankedDocumentIds: ["doc-13"],
      inlinedDocumentIds: [],
    });
    expect(counts.checked).to.equal(0);
    expect(counts.FALSE_ABSENCE).to.equal(0);
  });

  it("returns empty counts for an empty answer or a turn with no case, without a database call", async () => {
    for (const input of [
      { assistantMessageId: "m", caseId: "c", answer: "   ", rankedDocumentIds: [], inlinedDocumentIds: [] },
      { assistantMessageId: "m", caseId: "", answer: "D01 says something.", rankedDocumentIds: [], inlinedDocumentIds: [] },
    ]) {
      const counts = await GroundingVerifierSvc.verifyAnswer(input);
      expect(counts.checked).to.equal(0);
    }
  });
});
