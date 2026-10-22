import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import { extractCrossExamination, pageOfQuote } from "../src/utils/cross-examination-parse";
import { buildCrossExaminationPromptBody, CROSS_EXAM_MAX_QUESTIONS } from "../src/constants/cross-examination.constants";
import CrossExaminationSvc from "../src/services/cross-examination.service";
import CaseAccess from "../src/utils/case-access";
import WitnessRepo from "../src/repositories/witness.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";

const block = (rows: unknown[]) => `[CROSS_EXAMINATION]\n${JSON.stringify(rows)}\n[/CROSS_EXAMINATION]`;
const row = (over: Record<string, unknown> = {}) => ({
  topic: "The delivery date",
  question: "The goods arrived on 14 March, didn't they?",
  purpose: "Fixes the delivery before the notice.",
  document: "D2",
  quote: "the consignment was delivered on 14 March 2024",
  ...over,
});

describe("extractCrossExamination", () => {
  it("returns undefined when there is no block at all", () => {
    expect(extractCrossExamination("I could not find anything")).to.equal(undefined);
  });

  it("returns an empty array when the model found nothing to put", () => {
    expect(extractCrossExamination(block([]))).to.deep.equal([]);
  });

  it("parses a well-formed row and normalises the handle", () => {
    expect(extractCrossExamination(block([row({ document: "[d2]" })]))).to.deep.equal([
      {
        topic: "The delivery date",
        question: "The goods arrived on 14 March, didn't they?",
        purpose: "Fixes the delivery before the notice.",
        documentHandle: "D2",
        quote: "the consignment was delivered on 14 March 2024",
      },
    ]);
  });

  it("parses an unclosed block (streaming cutoff)", () => {
    expect(extractCrossExamination(`[CROSS_EXAMINATION]\n${JSON.stringify([row()])}`)).to.have.length(1);
  });

  it("drops a row with no quote, no document, or a quote too short to be a source", () => {
    const rows = [row({ quote: undefined }), row({ document: undefined }), row({ quote: "14 March" })];
    expect(extractCrossExamination(block(rows))).to.deep.equal([]);
  });

  it("drops a quote over the limit rather than shortening it, which would stop it matching", () => {
    expect(extractCrossExamination(block([row({ quote: "word ".repeat(120) })]))).to.deep.equal([]);
  });

  it("gives a row with no topic the General topic", () => {
    expect(extractCrossExamination(block([row({ topic: "" })]))![0].topic).to.equal("General");
  });

  it("drops a repeated question, ignoring case, and stops at the cap", () => {
    const repeated = [row(), row({ question: "THE GOODS ARRIVED ON 14 MARCH, DIDN'T THEY?" })];
    expect(extractCrossExamination(block(repeated))).to.have.length(1);
    const many = Array.from({ length: CROSS_EXAM_MAX_QUESTIONS + 5 }, (_, i) => row({ question: `Question ${i}?` }));
    expect(extractCrossExamination(block(many))).to.have.length(CROSS_EXAM_MAX_QUESTIONS);
  });
});

describe("pageOfQuote", () => {
  const chunks = [
    { pageNumber: 1, text: "Statement of Jane Doe. I am the site manager." },
    { pageNumber: 2, text: "On the morning in question the consignment was delivered on" },
    { pageNumber: 3, text: "14 March 2024 and signed for by the night porter." },
  ];

  it("finds the page holding the whole quote, ignoring spacing and case", () => {
    expect(pageOfQuote(chunks, "i am the   SITE manager")).to.equal(1);
  });

  it("uses the opening words when the quote runs across two chunks", () => {
    expect(pageOfQuote(chunks, "the consignment was delivered on 14 March 2024")).to.equal(2);
  });

  it("returns null when the quote is on no page, or the chunks carry no page numbers", () => {
    expect(pageOfQuote(chunks, "nothing like this appears anywhere")).to.equal(null);
    expect(pageOfQuote([{ pageNumber: null, text: "I am the site manager." }], "I am the site manager")).to.equal(null);
  });
});

describe("buildCrossExaminationPromptBody", () => {
  const prompt = buildCrossExaminationPromptBody(
    {
      caseName: "Doe v Acme",
      witness: { name: "Jane Doe", role: "Site manager", summary: null },
      documents: [{ handle: "D1", name: "Doe statement.pdf", text: "I am the site manager." }],
      contradictions: ['D1 p.2 "delivered 14 March" vs D3 "delivered 18 March"'],
      credibilityPoints: [],
    },
    "an England & Wales",
  );

  it("frames the witness as the other side's, never our own", () => {
    expect(prompt).to.include("a witness called by the other side");
    expect(prompt).to.include("not advising on the merits, citing authority, or preparing this witness's own evidence");
  });

  it("lists each document under its handle with its text, and the contradictions to test", () => {
    expect(prompt).to.include("[D1] Doe statement.pdf\n<<<\nI am the site manager.\n>>>");
    expect(prompt).to.include('- D1 p.2 "delivered 14 March" vs D3 "delivered 18 March"');
    expect(prompt).to.include("- none recorded");
  });
});

describe("CrossExaminationSvc.beginQueued", () => {
  const restore: (() => void)[] = [];
  function stub(target: any, key: string, value: unknown) {
    const original = target[key];
    target[key] = value;
    restore.push(() => (target[key] = original));
  }
  afterEach(() => restore.splice(0).reverse().forEach((undo) => undo()));

  async function begin(calledBy: string | null) {
    let claimed = false;
    stub(CaseAccess, "assertCanEdit", async () => undefined);
    stub(WitnessRepo, "find", async () => ({ id: "w1", caseId: "c1", calledBy }));
    stub(AiGenerationLockSvc, "assertAnalysisIdle", async () => undefined);
    stub(AiGenerationLockSvc, "begin", async () => {
      claimed = true;
    });
    try {
      await CrossExaminationSvc.beginQueued("c1", "w1", "u1");
      return { claimed, error: null as any };
    } catch (error) {
      return { claimed, error: error as any };
    }
  }

  it("refuses our own witness, or one nobody has said who calls, without claiming the job", async () => {
    for (const side of ["OURS", null]) {
      const { claimed, error } = await begin(side);
      expect(error?.statusCode).to.equal(400);
      expect(claimed).to.equal(false);
    }
  });

  it("claims the job for a witness the other side calls", async () => {
    const { claimed, error } = await begin("THEIRS");
    expect(error).to.equal(null);
    expect(claimed).to.equal(true);
  });
});
