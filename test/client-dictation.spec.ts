/** The client app's voice input (ClientDictationSvc): which recordings are accepted, how a job is
 * tied to the account that started it, and how a transcript is cleaned for a composer. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { isTranscribeJobNotFound } from "../src/services/transcription.service";
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

  it("reads a transcript of several voices as plain text, with no timestamps or paragraph breaks", () => {
    const transcript = "[TS:12.34] [Speaker 0]: I was fired last week.\n\n[TS:15.01] [Speaker 1]: Turn that down.\n\n[TS:17.5] [Speaker 0]: Without notice.";
    expect(plainDictation(transcript)).to.equal("I was fired last week. Turn that down. Without notice.");
  });

  it("tells AWS's unknown-job error from any other failure", () => {
    const missing = Object.assign(new Error("The requested job couldn't be found."), { name: "BadRequestException" });
    expect(isTranscribeJobNotFound(missing)).to.equal(true);
    expect(isTranscribeJobNotFound(Object.assign(new Error("Too many jobs"), { name: "LimitExceededException" }))).to.equal(false);
    expect(isTranscribeJobNotFound(new Error("The requested job couldn't be found."))).to.equal(false);
    expect(isTranscribeJobNotFound(null)).to.equal(false);
  });
});
