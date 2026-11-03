/** The client app's voice input (ClientDictationSvc): which recordings are accepted, how a job is
 * tied to the account that started it, and how a transcript is cleaned for a composer. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { dictationExtension, dictationJobName, dictationKey, plainDictation } from "../src/services/client-dictation.service";

describe("ClientDictationSvc", () => {
  it("reads the format from what a browser records, ignoring the codec", () => {
    expect(dictationExtension("audio/webm;codecs=opus")).to.equal("webm");
    expect(dictationExtension("audio/mp4")).to.equal("mp4");
    expect(dictationExtension("AUDIO/WAV")).to.equal("wav");
  });

  it("turns away anything Transcribe can't read", () => {
    expect(dictationExtension("application/pdf")).to.equal(null);
    expect(dictationExtension("video/webm")).to.equal(null);
  });

  it("puts the account in the job name and the clip's key, so another account can't reach it", () => {
    expect(dictationJobName("u1", "abc")).to.equal("dictation-u1-abc");
    expect(dictationKey("u1", "abc", "webm")).to.equal("dictation/u1/abc.webm");
  });

  it("drops speaker labels from a dictation", () => {
    expect(plainDictation("[Speaker 0]: I was fired.")).to.equal("I was fired.");
    expect(plainDictation("  Just words.  ")).to.equal("Just words.");
  });
});
