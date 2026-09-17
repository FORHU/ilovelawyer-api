/** AWS Transcribe's diarization (ShowSpeakerLabels: true) always returns a speaker_labels
 * .segments array, even for a solo recording — every segment just gets tagged "spk_0". Before
 * this fix, fetchTranscriptText tagged every paragraph/pause split with "[TS:...] [Speaker N]:"
 * regardless of how many distinct speakers were actually detected, so a single-speaker
 * recording rendered as a multi-turn conversation transcript. Only a transcript with more than
 * one distinct speaker label should get that tagged format now.
 *
 * No AWS/network: axios.get is monkeypatched to return a synthetic Transcribe result JSON,
 * same pattern as message-persistence-durability.spec.ts's sqs monkeypatching.
 */
import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import axios from "axios";
import { fetchTranscriptText } from "../src/services/transcription.service";

function mockAxiosGet(data: unknown) {
  (axios as any).get = async () => ({ data });
}

describe("fetchTranscriptText — single vs. multi speaker formatting", () => {
  const originalGet = axios.get;
  afterEach(() => {
    axios.get = originalGet;
  });

  it("omits speaker/timestamp tags when only one speaker is detected, even across a pause split", async () => {
    // Two words five seconds apart (> the 2s pause threshold) forces a paragraph split
    // mid-transcript — the bug reproduced specifically at a split, not just on a single buffer.
    mockAxiosGet({
      results: {
        transcripts: [{ transcript: "Hello. World." }],
        items: [
          { type: "pronunciation", start_time: "0.00", end_time: "0.50", alternatives: [{ content: "Hello" }] },
          { type: "punctuation", alternatives: [{ content: "." }] },
          { type: "pronunciation", start_time: "5.00", end_time: "5.50", alternatives: [{ content: "World" }] },
          { type: "punctuation", alternatives: [{ content: "." }] },
        ],
        speaker_labels: {
          segments: [
            { start_time: "0.00", end_time: "0.50", speaker_label: "spk_0", items: [{ start_time: "0.00" }] },
            { start_time: "5.00", end_time: "5.50", speaker_label: "spk_0", items: [{ start_time: "5.00" }] },
          ],
        },
      },
    });

    const result = await fetchTranscriptText("https://example.com/fake-transcript.json");

    expect(result).to.not.match(/\[Speaker/);
    expect(result).to.not.match(/\[TS:/);
    expect(result).to.include("Hello");
    expect(result).to.include("World");
  });

  it("keeps the tagged conversational format when more than one speaker is detected", async () => {
    mockAxiosGet({
      results: {
        transcripts: [{ transcript: "Hello. World." }],
        items: [
          { type: "pronunciation", start_time: "0.00", end_time: "0.50", alternatives: [{ content: "Hello" }] },
          { type: "punctuation", alternatives: [{ content: "." }] },
          { type: "pronunciation", start_time: "1.00", end_time: "1.50", alternatives: [{ content: "World" }] },
          { type: "punctuation", alternatives: [{ content: "." }] },
        ],
        speaker_labels: {
          segments: [
            { start_time: "0.00", end_time: "0.50", speaker_label: "spk_0", items: [{ start_time: "0.00" }] },
            { start_time: "1.00", end_time: "1.50", speaker_label: "spk_1", items: [{ start_time: "1.00" }] },
          ],
        },
      },
    });

    const result = await fetchTranscriptText("https://example.com/fake-transcript.json");

    expect(result).to.include("[Speaker 0]:");
    expect(result).to.include("[Speaker 1]:");
  });

  it("falls back to the plain transcript when there is no diarization data at all", async () => {
    mockAxiosGet({ results: { transcripts: [{ transcript: "Just plain text." }] } });

    const result = await fetchTranscriptText("https://example.com/fake-transcript.json");

    expect(result).to.equal("Just plain text.");
  });
});
