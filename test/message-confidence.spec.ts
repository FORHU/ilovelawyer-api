/**
 * Confidence view persistence helpers: citation spans re-pointed at the links as saved, and the
 * payload sealed like Message.content (its spans quote the answer verbatim). No DB.
 */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, afterEach } from "mocha";

import * as config from "../src/config";
import {
  confidenceViewEnabled,
  openConfidencePayload,
  remapConfidenceCitations,
  sealConfidencePayload,
} from "../src/utils/message-confidence";
import type { ConfidencePayload } from "../src/utils/response-parser";

const EXTERNAL = "https://www.legislation.gov.uk/ukpga/1996/18/section/94";
const LIBRARY = "/homepage/library/laws/abc?category=uk-legislation";

const payload = (): ConfidencePayload => ({
  v: 1,
  persona: "legal_uk",
  model: "gpt-5.6-luna",
  coverage: "partial",
  spans: [
    { quote: "Dismissal must be fair.", tier: "SOURCED", source: "provenance", why: "64%", ref: null },
    { quote: "ERA 1996, s 94 Law", tier: "QUOTED", source: "citation", why: "resolves", ref: EXTERNAL },
    { quote: "Some Case Jurisprudence", tier: "QUOTED", source: "citation", why: "resolves", ref: "https://caselaw.example/x" },
  ],
});

describe("remapConfidenceCitations", () => {
  it("re-points a rewritten link and drops a stripped one", () => {
    const map = new Map<string, string | null>([
      [EXTERNAL, LIBRARY],
      ["https://caselaw.example/x", null],
    ]);
    const spans = remapConfidenceCitations(payload(), map).spans;
    expect(spans.map((s) => s.ref)).to.deep.equal([null, LIBRARY]);
    expect(spans).to.have.length(2);
  });

  it("leaves spans alone when nothing was rewritten", () => {
    expect(remapConfidenceCitations(payload(), undefined).spans).to.have.length(3);
    expect(remapConfidenceCitations(payload(), new Map()).spans[1].ref).to.equal(EXTERNAL);
  });

  it("keeps a citation whose href the rewrite never saw", () => {
    const spans = remapConfidenceCitations(payload(), new Map([[EXTERNAL, LIBRARY]])).spans;
    expect(spans[2].ref).to.equal("https://caselaw.example/x");
  });
});

describe("sealed confidence payload", () => {
  const original = {
    enabled: (config as any).FIELD_ENCRYPTION_ENABLED,
    key: (config as any).FIELD_ENCRYPTION_KEY,
  };
  afterEach(() => {
    (config as any).FIELD_ENCRYPTION_ENABLED = original.enabled;
    (config as any).FIELD_ENCRYPTION_KEY = original.key;
    delete process.env.CONFIDENCE_VIEW_ENABLED;
  });

  it("is encrypted at rest when field encryption is on, and opens back to the same payload", () => {
    (config as any).FIELD_ENCRYPTION_ENABLED = true;
    (config as any).FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    const stored = sealConfidencePayload(payload());
    expect(stored).to.not.include("Dismissal must be fair.");
    expect(openConfidencePayload(stored)).to.deep.equal(payload());
  });

  it("is plain JSON when field encryption is off, and still opens", () => {
    (config as any).FIELD_ENCRYPTION_ENABLED = false;
    const stored = sealConfidencePayload(payload());
    expect(stored).to.include("Dismissal must be fair.");
    expect(openConfidencePayload(stored)?.spans).to.have.length(3);
  });

  it("treats missing or unreadable payloads as absent", () => {
    expect(openConfidencePayload(null)).to.equal(null);
    expect(openConfidencePayload("not json")).to.equal(null);
    expect(openConfidencePayload(JSON.stringify({ v: 9, spans: [] }))).to.equal(null);
  });

  it("is off unless CONFIDENCE_VIEW_ENABLED=true", () => {
    expect(confidenceViewEnabled()).to.equal(false);
    process.env.CONFIDENCE_VIEW_ENABLED = "true";
    expect(confidenceViewEnabled()).to.equal(true);
  });
});
