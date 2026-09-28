/**
 * Jev checking an Audio Overview script (audio-overview-jev.ts): each turn judged against the
 * case data, filler turns skipped, a failed call left unchecked. Jev is stubbed at
 * TypeSafeClient.prototype.systemOne, same as mind-map-jev.spec.ts. No DB.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { checkAudioOverviewTurns, judgeAudioOverviewTurn } from "../src/utils/audio-overview-jev";
import { CONTRADICTION_MIN_CONFIDENCE, MindMapJevContext } from "../src/utils/mind-map-jev";
import type { AudioOverviewTurn } from "../src/utils/response-parser";

const context: MindMapJevContext = {
  parties: ["Cruz (plaintiff)"],
  legalIssues: ["Default on the note"],
  strengths: [],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-06-01 — Loan due"],
  witnesses: [],
  damages: [],
};

const turns: AudioOverviewTurn[] = [
  { speaker: "HOST_A", text: "Welcome back, let's dig in." },
  { speaker: "HOST_B", text: "The loan fell due on June first." },
  { speaker: "HOST_A", text: "And Reyes paid in full." },
];

describe("audio-overview-jev", () => {
  const originalSystemOne = TypeSafeClient.prototype.systemOne;
  let reply: (text: string) => { choice: string; confidence: number } | Error;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    reply = () => ({ choice: "SUPPORTED", confidence: 0.9 });
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: any }) => {
      const answer = reply(req.state.turn);
      if (answer instanceof Error) throw answer;
      return { answers: { support: answer } };
    };
  });

  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originalSystemOne;
  });

  it("returns null for a turn that asserts nothing about the case", async () => {
    reply = () => ({ choice: "NOT_A_CLAIM", confidence: 0.95 });
    expect(await judgeAudioOverviewTurn(turns[0]!.text, context)).to.equal(null);
  });

  it("downgrades a low-confidence CONTRADICTED to UNSUPPORTED", async () => {
    reply = () => ({ choice: "CONTRADICTED", confidence: CONTRADICTION_MIN_CONFIDENCE - 0.1 });
    expect((await judgeAudioOverviewTurn(turns[2]!.text, context))?.verdict).to.equal("UNSUPPORTED");
  });

  it("checks claim turns by index, skips filler, and leaves a failed call unchecked", async () => {
    reply = (text) => {
      if (text.startsWith("Welcome")) return { choice: "NOT_A_CLAIM", confidence: 0.9 };
      if (text.includes("paid in full")) return new Error("Jev unavailable");
      return { choice: "SUPPORTED", confidence: 0.9 };
    };
    const checks = await checkAudioOverviewTurns(turns, context);
    expect(checks.map((c) => [c.turn, c.verdict])).to.deep.equal([[1, "SUPPORTED"]]);
  });
});
