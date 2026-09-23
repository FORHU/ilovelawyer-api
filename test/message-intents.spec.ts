import { expect } from "chai";
import { describe, it } from "mocha";
import {
  MESSAGE_INTENTS,
  INTENT_DEFINITIONS,
  INTENT_LABELS,
  INTENT_HINTS,
  isMessageIntent,
  intentQuestion,
  parseTriage,
  intentContextFor,
  RawTriageAnswers,
  URGENCY_THRESHOLD,
  INTENT_HINT_THRESHOLD,
} from "../src/utils/message-triage";

/** A well-formed Jev reply for one intent, overridable per test. */
function answers(overrides: Partial<{ choice: string; confidence: number; probabilities: Record<string, number>; urgency: number; attachment: number; language: string; languageConfidence: number }> = {}): RawTriageAnswers {
  return {
    urgency: { noul: overrides.urgency ?? 0.05 },
    intent: {
      choice: overrides.choice ?? "CONSULTATION",
      confidence: overrides.confidence ?? 0.9,
      probabilities: overrides.probabilities ?? { CONSULTATION: 0.9, OTHER: 0.1 },
    },
    attachment: { noul: overrides.attachment ?? 0.05 },
    replyLanguage: { choice: overrides.language ?? "ENGLISH", confidence: overrides.languageConfidence ?? 0.99 },
  };
}

describe("MESSAGE_INTENTS", () => {
  describe("the set itself", () => {
    it("is the routes the legal persona can act on, plus a non-request bucket — and nothing else", () => {
      // Deliberately exact: adding an intent is a product decision (it needs a route, ≥6 benchmark
      // contrast cases and a re-run), so a new label should fail this test until it's been through that.
      expect([...MESSAGE_INTENTS]).to.deep.equal([
        "CONSULTATION",
        "DRAFT_DOCUMENT",
        "DRAFT_PLEADING",
        "ANALYZE_DOCUMENT",
        "LEGAL_RESEARCH",
        "PARALEGAL_TASK",
        "DEADLINE_COMPUTATION",
        "REVISE_PREVIOUS",
        "OTHER",
      ]);
    });

    it("has unique UPPER_SNAKE labels — they're persisted on Message.intent and grouped on", () => {
      expect(new Set(MESSAGE_INTENTS).size).to.equal(MESSAGE_INTENTS.length);
      for (const k of MESSAGE_INTENTS) expect(k).to.match(/^[A-Z][A-Z_]*[A-Z]$/);
    });

    it("keeps OTHER last so Jev sees the catch-all after every real option", () => {
      expect(MESSAGE_INTENTS[MESSAGE_INTENTS.length - 1]).to.equal("OTHER");
    });

    it("stays small enough for a single choice() to stay confident", () => {
      // Confidence spreads thin past ~12 options and the 0.7 hint bar starts blocking everything.
      expect(MESSAGE_INTENTS.length).to.be.at.most(12);
    });
  });

  describe("every intent is fully described", () => {
    for (const k of MESSAGE_INTENTS) {
      it(`${k} has a definition, a human label, and appears in the Jev question`, () => {
        expect(INTENT_DEFINITIONS[k], "definition").to.be.a("string").with.length.greaterThan(20);
        expect(INTENT_LABELS[k], "label").to.be.a("string").with.length.greaterThan(2);
        expect(INTENT_LABELS[k]).to.equal(INTENT_LABELS[k].toLowerCase(), "labels read as prose in titles");
        expect(intentQuestion()).to.include(`${k} — ${INTENT_DEFINITIONS[k]}`);
      });
    }

    it("lists intents in the question in MESSAGE_INTENTS order, one per line", () => {
      const lines = intentQuestion().split("\n").slice(1);
      expect(lines.map((l) => l.split(" — ")[0])).to.deep.equal([...MESSAGE_INTENTS]);
    });

    it("gives human labels that are distinct from each other", () => {
      expect(new Set(Object.values(INTENT_LABELS)).size).to.equal(MESSAGE_INTENTS.length);
    });
  });

  describe("which intents steer chat-wonder", () => {
    it("steers exactly the 'produce something' intents and leaves the persona's defaults alone", () => {
      const steered = MESSAGE_INTENTS.filter((k) => INTENT_HINTS[k]);
      expect(steered).to.deep.equal(["DRAFT_DOCUMENT", "DRAFT_PLEADING", "ANALYZE_DOCUMENT", "PARALEGAL_TASK", "DEADLINE_COMPUTATION", "REVISE_PREVIOUS"]);
      const unsteered = MESSAGE_INTENTS.filter((k) => !INTENT_HINTS[k]);
      expect(unsteered).to.deep.equal(["CONSULTATION", "LEGAL_RESEARCH", "OTHER"]);
    });

    it("every hint tells the model what to produce, not just what the label is", () => {
      for (const k of MESSAGE_INTENTS) {
        const hint = INTENT_HINTS[k];
        if (!hint) continue;
        expect(hint, k).to.have.length.greaterThan(80);
        expect(hint, `${k} should not merely restate its own label`).to.not.include(k);
      }
    });

    it("the hint header carries the label and rounded confidence", () => {
      const ctx = intentContextFor(parseTriage(answers({ choice: "DEADLINE_COMPUTATION", confidence: 0.834 })));
      expect(ctx.split("\n")[0]).to.equal("[REQUEST TYPE: DEADLINE_COMPUTATION (83% confidence).]");
    });
  });

  describe("parseTriage — reply language", () => {
    it("passes a known language through with its confidence", () => {
      const t = parseTriage(answers({ language: "TAGALOG", languageConfidence: 0.93 }))
      expect(t.replyLanguage).to.equal("TAGALOG")
      expect(t.replyLanguageConfidence).to.equal(0.93)
    })

    it("maps an unrecognised language label to OTHER, so the tenant default takes over", () => {
      expect(parseTriage(answers({ language: "SWAHILI" })).replyLanguage).to.equal("OTHER")
      expect(parseTriage(answers({ language: "" })).replyLanguage).to.equal("OTHER")
    })
  })

  describe("isMessageIntent", () => {
    it("accepts every listed intent and rejects everything else", () => {
      for (const k of MESSAGE_INTENTS) expect(isMessageIntent(k), k).to.equal(true);
      for (const bad of ["consultation", "DRAFT", "", null, undefined, 3, {}, "DRAFT_DOCUMENT "]) expect(isMessageIntent(bad), String(bad)).to.equal(false);
    });
  });

  describe("parseTriage (Jev answers → MessageTriage, no network)", () => {
    it("passes a known intent through with its confidence and probabilities", () => {
      const t = parseTriage(answers({ choice: "DRAFT_PLEADING", confidence: 0.88, probabilities: { DRAFT_PLEADING: 0.88, CONSULTATION: 0.1 } }));
      expect(t.intent).to.equal("DRAFT_PLEADING");
      expect(t.intentConfidence).to.equal(0.88);
      expect(t.intentProbabilities).to.deep.equal({ DRAFT_PLEADING: 0.88, CONSULTATION: 0.1 });
    });

    it("maps an unknown or malformed label to OTHER instead of throwing — an SDK or prompt change must never take a chat turn down", () => {
      expect(parseTriage(answers({ choice: "SCHEDULE" })).intent).to.equal("OTHER");
      expect(parseTriage(answers({ choice: "draft_document" })).intent).to.equal("OTHER");
      expect(parseTriage(answers({ choice: "" })).intent).to.equal("OTHER");
    });

    it("drops unknown keys from the probability map so the persisted shape only ever holds real intents", () => {
      const t = parseTriage(answers({ probabilities: { CONSULTATION: 0.7, SCHEDULE: 0.2, OTHER: 0.1 } }));
      expect(t.intentProbabilities).to.deep.equal({ CONSULTATION: 0.7, OTHER: 0.1 });
    });

    it("applies URGENCY_THRESHOLD at the boundary and keeps the raw probabilities", () => {
      expect(parseTriage(answers({ urgency: URGENCY_THRESHOLD })).urgent).to.equal(true);
      expect(parseTriage(answers({ urgency: URGENCY_THRESHOLD - 0.001 })).urgent).to.equal(false);
      const t = parseTriage(answers({ urgency: 0.42, attachment: 0.77 }));
      expect(t.probability).to.equal(0.42);
      expect(t.refersToAttachment).to.equal(0.77);
    });

    it("an unknown label never produces a steer, even at high confidence", () => {
      const t = parseTriage(answers({ choice: "SCHEDULE", confidence: 0.99 }));
      expect(t.intent).to.equal("OTHER");
      expect(intentContextFor(t)).to.equal("");
    });

    it("a known steered intent below the hint bar is stored but not injected", () => {
      const t = parseTriage(answers({ choice: "DRAFT_DOCUMENT", confidence: INTENT_HINT_THRESHOLD - 0.05 }));
      expect(t.intent).to.equal("DRAFT_DOCUMENT");
      expect(intentContextFor(t)).to.equal("");
    });
  });
});
