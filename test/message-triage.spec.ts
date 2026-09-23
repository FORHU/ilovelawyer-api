import { expect } from "chai";
import { describe, it } from "mocha";
import {
  flagMessageUrgency,
  triageMessage,
  urgencyContextFor,
  intentContextFor,
  missingAttachmentContextFor,
  notificationFor,
  resolveReplyLanguage,
  triageContextFor,
  MESSAGE_INTENTS,
  MessageTriage,
  INTENT_HINT_THRESHOLD,
  ATTACHMENT_THRESHOLD,
  URGENCY_NOTIFY_THRESHOLD,
  URGENCY_THRESHOLD,
  REPLY_LANGUAGE_MIN_CONFIDENCE,
} from "../src/utils/message-triage";

const routineConsultation: MessageTriage = {
  urgent: false,
  probability: 0.05,
  intent: "CONSULTATION",
  intentConfidence: 0.9,
  intentProbabilities: { CONSULTATION: 0.9 },
  refersToAttachment: 0.05,
  replyLanguage: "ENGLISH",
  replyLanguageConfidence: 0.99,
};

describe("Jev message triage", () => {
  it("is a no-op when USE_JEV_MESSAGE_TRIAGE is unset (no live call, null result)", async () => {
    // Control the flag here rather than assuming the ambient environment: .env sets it to true, and
    // whether that has been loaded by the time this file runs depends on which other specs share
    // the process. Asserting against an ambient value made this test pass or fail on import order.
    const previous = process.env.USE_JEV_MESSAGE_TRIAGE;
    delete process.env.USE_JEV_MESSAGE_TRIAGE;
    try {
      expect(await triageMessage("The sheriff executes tomorrow morning.")).to.equal(null);
      expect(await flagMessageUrgency("The sheriff executes tomorrow morning.")).to.equal(null);
    } finally {
      if (previous !== undefined) process.env.USE_JEV_MESSAGE_TRIAGE = previous;
    }
  });

  it("keeps the notification bar above the classification bar", () => {
    expect(URGENCY_NOTIFY_THRESHOLD).to.be.greaterThan(URGENCY_THRESHOLD);
  });

  it("covers every capability the legal persona can act on, plus a non-request bucket", () => {
    expect(MESSAGE_INTENTS).to.include.members([
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

  describe("urgencyContextFor", () => {
    it("returns an empty string for a routine or untriaged turn so it filters out of resolvedContext", () => {
      expect(urgencyContextFor(null)).to.equal("");
      expect(urgencyContextFor({ urgent: false, probability: 0.1 })).to.equal("");
    });

    it("produces a directive note with the rounded confidence for an urgent turn", () => {
      const note = urgencyContextFor({ urgent: true, probability: 0.987 });
      expect(note.startsWith("[URGENT")).to.equal(true);
      expect(note).to.include("99% confidence");
      // The point of the rewrite: tell the model what to do differently, not just that it's urgent.
      expect(note).to.include("Open with the single most important action");
      expect(note).to.include("numbered, dated checklist");
      expect(note).to.include("under 600 words");
    });
  });

  describe("intentContextFor", () => {
    it("says nothing for the persona's default intents, OTHER, or an untriaged turn", () => {
      expect(intentContextFor(null)).to.equal("");
      expect(intentContextFor(routineConsultation)).to.equal("");
      expect(intentContextFor({ ...routineConsultation, intent: "LEGAL_RESEARCH" })).to.equal("");
      expect(intentContextFor({ ...routineConsultation, intent: "OTHER" })).to.equal("");
    });

    it("steers document, pleading, analysis and paralegal requests toward producing the artefact", () => {
      const doc = intentContextFor({ ...routineConsultation, intent: "DRAFT_DOCUMENT", intentConfidence: 0.92 });
      expect(doc).to.include("[REQUEST TYPE: DRAFT_DOCUMENT (92% confidence).]");
      expect(doc).to.include("finished document, not a description of one");

      expect(intentContextFor({ ...routineConsultation, intent: "DRAFT_PLEADING" })).to.include("court filing");
      expect(intentContextFor({ ...routineConsultation, intent: "ANALYZE_DOCUMENT" })).to.include("quote or cite the clause");
      expect(intentContextFor({ ...routineConsultation, intent: "PARALEGAL_TASK" })).to.include("work product");
      expect(intentContextFor({ ...routineConsultation, intent: "DEADLINE_COMPUTATION" })).to.include("Show the computation");
      expect(intentContextFor({ ...routineConsultation, intent: "REVISE_PREVIOUS" })).to.include("change the previous answer");
    });

    it("withholds the hint below the confidence threshold — a wrong steer is worse than none", () => {
      const low = { ...routineConsultation, intent: "DRAFT_PLEADING" as const, intentConfidence: INTENT_HINT_THRESHOLD - 0.01 };
      expect(intentContextFor(low)).to.equal("");
      const atBar = { ...low, intentConfidence: INTENT_HINT_THRESHOLD };
      expect(intentContextFor(atBar)).to.not.equal("");
    });
  });

  describe("missingAttachmentContextFor", () => {
    const dependsOnDoc = { ...routineConsultation, intent: "ANALYZE_DOCUMENT" as const, refersToAttachment: 0.9 };

    it("fires only when the message depends on a document and nothing is attached or grounded", () => {
      expect(missingAttachmentContextFor(dependsOnDoc, false)).to.include("[NO DOCUMENT AVAILABLE");
      expect(missingAttachmentContextFor(dependsOnDoc, true)).to.equal("");
      expect(missingAttachmentContextFor({ ...dependsOnDoc, refersToAttachment: ATTACHMENT_THRESHOLD - 0.01 }, false)).to.equal("");
      expect(missingAttachmentContextFor(null, false)).to.equal("");
    });

    it("never fires on a revision — 'redo the demand letter in Tagalog' refers to the previous draft, not an attachment", () => {
      expect(missingAttachmentContextFor({ ...dependsOnDoc, intent: "REVISE_PREVIOUS" }, false)).to.equal("");
    });

    it("tells the model to say so and not to guess", () => {
      const guard = missingAttachmentContextFor(dependsOnDoc, false);
      expect(guard).to.include("Do not guess or reconstruct");
      expect(guard).to.include("ask the user to upload or paste it");
    });
  });

  describe("resolveReplyLanguage", () => {
    it("maps a confident detection to its locale", () => {
      expect(resolveReplyLanguage(routineConsultation, "en")).to.equal("en");
      expect(resolveReplyLanguage({ ...routineConsultation, replyLanguage: "TAGALOG" }, "en")).to.equal("tl");
      expect(resolveReplyLanguage({ ...routineConsultation, replyLanguage: "KOREAN" }, "en")).to.equal("ko");
    });

    it("lets a confident detection override the stated preference — writing in Tagalog gets Tagalog", () => {
      expect(resolveReplyLanguage({ ...routineConsultation, replyLanguage: "TAGALOG" }, "en")).to.equal("tl");
    });

    it("falls back to the USER'S OWN language below the bar, not to English", () => {
      // The whole point of the correction: an uncertain read must not force English on someone
      // who told us they speak Tagalog. "res ipsa loquitur" read at 44% in the live comparison.
      const unsure = { ...routineConsultation, replyLanguage: "ENGLISH" as const, replyLanguageConfidence: REPLY_LANGUAGE_MIN_CONFIDENCE - 0.01 };
      expect(resolveReplyLanguage(unsure, "tl")).to.equal("tl");
      expect(resolveReplyLanguage(unsure, "ko")).to.equal("ko");
      expect(resolveReplyLanguage(unsure, "en")).to.equal("en");
    });

    it("respects the bar itself", () => {
      const atBar = { ...routineConsultation, replyLanguage: "TAGALOG" as const, replyLanguageConfidence: REPLY_LANGUAGE_MIN_CONFIDENCE };
      expect(resolveReplyLanguage(atBar, "en")).to.equal("tl");
    });

    it("falls back on OTHER however confident it is — we only answer in languages we serve", () => {
      expect(resolveReplyLanguage({ ...routineConsultation, replyLanguage: "OTHER", replyLanguageConfidence: 1 }, "tl")).to.equal("tl");
    });

    it("returns undefined when triage did not run, leaving chat-wonder on its own detector", () => {
      expect(resolveReplyLanguage(null, "tl")).to.equal(undefined);
    });

    it("uses English as the last resort for a missing or unserved preference", () => {
      const unsure = { ...routineConsultation, replyLanguage: "OTHER" as const };
      for (const pref of [undefined, null, "", "  ", "fr", "zz"]) {
        expect(resolveReplyLanguage(unsure, pref), String(pref)).to.equal("en");
      }
    });

    it("is case- and whitespace-tolerant about the stored preference", () => {
      const unsure = { ...routineConsultation, replyLanguage: "OTHER" as const };
      expect(resolveReplyLanguage(unsure, " TL ")).to.equal("tl");
    });
  });

  describe("notificationFor", () => {
    it("stays silent for routine turns and for urgency below the notify bar", () => {
      expect(notificationFor(null, "X")).to.equal(null);
      expect(notificationFor(routineConsultation, "X")).to.equal(null);
      expect(notificationFor({ ...routineConsultation, urgent: true, probability: URGENCY_NOTIFY_THRESHOLD - 0.01 }, "X")).to.equal(null);
    });

    it("names the kind of request in the title, not just 'urgent message'", () => {
      const n = notificationFor({ ...routineConsultation, urgent: true, probability: 0.99, intent: "DRAFT_PLEADING" }, "Santos v. Reyes");
      expect(n?.reason).to.equal("urgent");
      expect(n?.title).to.equal("Urgent pleading request (99%) in Santos v. Reyes");
      const c = notificationFor({ ...routineConsultation, urgent: true, probability: 0.9, intent: "CONSULTATION" }, null);
      expect(c?.title).to.equal("Urgent consultation (90%) in a consultation");
    });
  });

  describe("triageContextFor", () => {
    it("puts the urgency block before the intent steer, blank-line separated, and is empty when neither applies", () => {
      expect(triageContextFor(null)).to.equal("");
      expect(triageContextFor(routineConsultation)).to.equal("");
      const both = triageContextFor({ ...routineConsultation, urgent: true, probability: 0.95, intent: "DRAFT_PLEADING" });
      const urgentIdx = both.indexOf("[URGENT");
      const intentIdx = both.indexOf("[REQUEST TYPE");
      expect(urgentIdx).to.equal(0);
      expect(intentIdx).to.be.greaterThan(urgentIdx);
      expect(both).to.include("\n\n[REQUEST TYPE");
    });

    it("orders urgency → missing-attachment guard → intent steer", () => {
      const all = triageContextFor(
        { ...routineConsultation, urgent: true, probability: 0.95, intent: "ANALYZE_DOCUMENT", refersToAttachment: 0.95 },
        { hasAttachedMaterial: false },
      );
      expect(all.indexOf("[URGENT")).to.be.lessThan(all.indexOf("[NO DOCUMENT AVAILABLE"));
      expect(all.indexOf("[NO DOCUMENT AVAILABLE")).to.be.lessThan(all.indexOf("[REQUEST TYPE"));
    });

    it("defaults to assuming material is attached, so callers that don't know can't trigger the guard by accident", () => {
      expect(triageContextFor({ ...routineConsultation, intent: "ANALYZE_DOCUMENT", refersToAttachment: 0.95 })).to.not.include("[NO DOCUMENT");
    });
  });
});
