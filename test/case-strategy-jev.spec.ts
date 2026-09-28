/**
 * Jev checking the Case Strategy panel's recommended approach (case-strategy-jev.ts) — judged
 * against the case data through the mind-map judge. Jev is stubbed at
 * TypeSafeClient.prototype.systemOne, same as mind-map-jev.spec.ts. No DB.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { checkStrategyItems, CASE_STRATEGY_JEV_MAX_ITEMS, isCaseStrategyJevEnabled } from "../src/utils/case-strategy-jev";
import type { MindMapJevContext } from "../src/utils/mind-map-jev";
import { createProcedureItemSchema } from "../src/validation/case-terminal.validation";

const context: MindMapJevContext = {
  parties: ["Maria Reyes (Petitioner)"],
  legalIssues: [],
  strengths: [],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-07-28 — Complaint docketed"],
  witnesses: [],
  damages: [],
};

describe("Case strategy Jev check", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let asked: { branch: string; text: string }[];
  let reply: (text: string) => { choice: string; confidence: number } | Error;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    asked = [];
    reply = () => ({ choice: "SUPPORTED", confidence: 0.9 });
    (TypeSafeClient.prototype as any).systemOne = async (req: any) => {
      asked.push(req.state.point);
      const answer = reply(req.state.point.text);
      if (answer instanceof Error) throw answer;
      return { answers: { support: answer } };
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    delete process.env.USE_JEV_CASE_STRATEGY;
  });

  it("is off unless USE_JEV_CASE_STRATEGY=true", () => {
    expect(isCaseStrategyJevEnabled()).to.equal(false);
    process.env.USE_JEV_CASE_STRATEGY = "true";
    expect(isCaseStrategyJevEnabled()).to.equal(true);
  });

  it("judges each item as a Recommended approach point and keeps the exact text it judged", async () => {
    const results = await checkStrategyItems([{ id: "a", label: "Plead the timeline as the factual core" }], context);
    expect(asked).to.deep.equal([{ branch: "Recommended approach", text: "Plead the timeline as the factual core" }]);
    expect(results[0]).to.deep.include({ id: "a", label: "Plead the timeline as the factual core" });
    expect(results[0].check.verdict).to.equal("SUPPORTED");
  });

  it("leaves an item unchecked when Jev fails, rather than marking it", async () => {
    reply = (text) => (text.includes("bad") ? new Error("boom") : { choice: "UNSUPPORTED", confidence: 0.8 });
    const results = await checkStrategyItems([{ id: "a", label: "fine" }, { id: "b", label: "bad one" }], context);
    expect(results.map((r) => r.id)).to.deep.equal(["a"]);
  });

  it("downgrades a low-confidence CONTRADICTED to UNSUPPORTED", async () => {
    reply = () => ({ choice: "CONTRADICTED", confidence: 0.4 });
    const [r] = await checkStrategyItems([{ id: "a", label: "x" }], context);
    expect(r.check.verdict).to.equal("UNSUPPORTED");
  });

  it("checks at most the per-run ceiling", async () => {
    const items = Array.from({ length: CASE_STRATEGY_JEV_MAX_ITEMS + 10 }, (_, i) => ({ id: `${i}`, label: `Move ${i}` }));
    const results = await checkStrategyItems(items, context);
    expect(results).to.have.length(CASE_STRATEGY_JEV_MAX_ITEMS);
  });
});

describe("createProcedureItemSchema (To checklist from another panel)", () => {
  it("accepts a sourceLabel and stays valid without one", () => {
    expect(createProcedureItemSchema.validate({ kind: "TODO", label: "Chase payroll cert", sourceLabel: "Weakness: no payroll certification" }).error).to.equal(undefined);
    expect(createProcedureItemSchema.validate({ kind: "TODO", label: "Chase payroll cert" }).error).to.equal(undefined);
  });
});
