/** openIntakeMessage's handling of replyAudioTimings.text — a markdown-stripped DUPLICATE of the
 * same assistant reply IntakeMessage.content already seals. Without its own sealing, turning on
 * INTAKE_FIELD_ENCRYPTION_ENABLED would still leave every voice reply's full text sitting in the
 * clear in this JSON column. Monkeypatches config's module object the same way other intake specs
 * do (see intake-chat.service.spec.ts's `stash`), since intake-field-crypto.ts reads it live on
 * every call, not just at import time. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import * as config from "../src/config";
import { openIntakeMessage, sealIntakeMessageContent, sealReplyAudioTimingsText } from "../src/utils/intake-message-content";

const KEY = "0".repeat(64); // a valid 32-byte hex key, test-only

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("intake message content: replyAudioTimings.text sealing", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stash(config, ["INTAKE_FIELD_ENCRYPTION_ENABLED", "INTAKE_FIELD_ENCRYPTION_KEY"]);
    (config as any).INTAKE_FIELD_ENCRYPTION_ENABLED = true;
    (config as any).INTAKE_FIELD_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => restore());

  it("seals replyAudioTimings.text the same as content, under its own label", () => {
    const sealedContent = sealIntakeMessageContent("That may be unfair dismissal.");
    const sealedTimingsText = sealReplyAudioTimingsText("That may be unfair dismissal.");
    expect(sealedContent.startsWith("enc1:")).to.equal(true);
    expect(sealedTimingsText.startsWith("enc1:")).to.equal(true);
    // Different labels are bound into the AEAD tag — sealing the same plaintext under each
    // produces different ciphertext, so one can never be swapped in for the other.
    expect(sealedContent).to.not.equal(sealedTimingsText);
  });

  it("opens replyAudioTimings.text back out, leaving sentenceTimings/wordTimings untouched", () => {
    const row = {
      id: "msg-1",
      content: sealIntakeMessageContent("That may be unfair dismissal."),
      replyAudioTimings: {
        text: sealReplyAudioTimingsText("That may be unfair dismissal."),
        sentenceTimings: [{ time: 0, start: 0, end: 10 }],
        wordTimings: [{ time: 0, start: 0, end: 4 }],
      },
    };
    const opened = openIntakeMessage(row);
    expect(opened?.content).to.equal("That may be unfair dismissal.");
    expect((opened?.replyAudioTimings as any).text).to.equal("That may be unfair dismissal.");
    expect((opened?.replyAudioTimings as any).sentenceTimings).to.deep.equal([{ time: 0, start: 0, end: 10 }]);
    expect((opened?.replyAudioTimings as any).wordTimings).to.deep.equal([{ time: 0, start: 0, end: 4 }]);
  });

  it("drops only the timings (never the whole message) when replyAudioTimings.text can't be opened", () => {
    const row = {
      id: "msg-1",
      content: "Plain, never sealed.",
      replyAudioTimings: { text: "enc1:deadbeef:not:a:real:value", sentenceTimings: [], wordTimings: [] },
    };
    const opened = openIntakeMessage(row);
    expect(opened).to.not.equal(null);
    expect(opened?.content).to.equal("Plain, never sealed.");
    expect(opened?.replyAudioTimings).to.equal(null);
  });

  it("leaves unsealed replyAudioTimings.text (encryption off, or never sealed) exactly as it is", () => {
    const row = {
      id: "msg-1",
      content: "Plain, never sealed.",
      replyAudioTimings: { text: "Plain, never sealed.", sentenceTimings: [], wordTimings: [] },
    };
    const opened = openIntakeMessage(row);
    expect((opened?.replyAudioTimings as any).text).to.equal("Plain, never sealed.");
  });
});
