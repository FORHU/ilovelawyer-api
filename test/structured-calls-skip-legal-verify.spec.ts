import { expect } from "chai";
import { describe, it } from "mocha";
import * as fs from "fs";
import * as path from "path";

/**
 * One-shot structured calls to Chat Wonder must send skipLegalVerify. Without it, the UK persona
 * runs its legal-answer flow on a prompt whose reply is a machine-readable block built from the
 * case documents: the verify/refine audit, and the research-first step chat-wonder forces on any
 * UK turn of six words or more (see chat-wonder-v2-api the_server.py `_uk_forced_first_tool`).
 * Source-level on purpose: the services need a database and a live Chat Wonder to run.
 *
 * Not listed: RedTeamSvc (its prompt asks for statute and case-law citations, and in a local
 * comparison the research-first step added a point the PR-only run missed), ChatSvc (a lawyer's own
 * question, where research-first is the point), AudioOverviewSvc (a discussion script, not a parsed
 * block), and the REST-path calls (CaseOutlookAiSvc, EvidenceIntelligenceSvc): chat-wonder only reads
 * skip_legal_verify on its WebSocket handler, so they cannot opt out from this repo.
 */
const STRUCTURED_CALL_SERVICES = [
  "witness-extract",
  "witness-scoring",
  "claim-extract",
  "case-theory",
  "theory-diff",
  "case-strategy",
  "case-reconstruction",
  "citation-ground",
  "case-finding-ai",
  "mind-map",
  "missing-evidence-ai",
];

// A call's arguments end well inside this window; a window past the call's end could borrow the
// option from the next call, so it is cut at the next call too.
const CALL_WINDOW = 600;

describe("one-shot Chat Wonder calls skip the legal-answer flow", () => {
  for (const name of STRUCTURED_CALL_SERVICES) {
    it(`${name}: every streamChatWonderMessage call sends skipLegalVerify`, () => {
      const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", `${name}.service.ts`), "utf8");
      const starts: number[] = [];
      for (let i = source.indexOf("streamChatWonderMessage("); i !== -1; i = source.indexOf("streamChatWonderMessage(", i + 1)) {
        starts.push(i);
      }
      expect(starts.length, `${name} makes no streamChatWonderMessage call`).to.be.greaterThan(0);
      starts.forEach((start, n) => {
        const end = Math.min(start + CALL_WINDOW, starts[n + 1] ?? Infinity);
        expect(source.slice(start, end), `call ${n + 1} in ${name}`).to.include("skipLegalVerify: true");
      });
    });
  }
});
