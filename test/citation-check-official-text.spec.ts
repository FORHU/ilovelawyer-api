/** #364: CitationCheckSvc fills in a citation's official text from the authority it resolved to
 * when the lawyer leaves it empty — and keeps the lawyer's own text when they don't.
 *
 * No live Postgres, juris.ph or UK Legal MCP: the repo, access checks, resolution, the text fetch,
 * the proposition classifier and pinpoint detection are stubbed. The validity check itself runs
 * for real on the heuristic path (USE_JEV_VALIDITY off), so the status shows what the text did.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CitationCheckSvc from "../src/services/citation-check.service";
import CitationCheckRepo from "../src/repositories/citation-check.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import ManualEditLog from "../src/services/manual-edit-log.service";
import CaseAccess from "../src/utils/case-access";
import * as SourceText from "../src/utils/citation-source-text";
import * as Proposition from "../src/utils/citation-proposition";
import * as Pinpoint from "../src/utils/citation-pinpoint";

const PASSAGE = "The employer may terminate the employee without notice where the employee has committed serious misconduct.";
const QUOTE = "the employee has committed serious misconduct";

const restore: (() => void)[] = [];
function stub(target: any, key: string, value: unknown) {
  const original = target[key];
  restore.push(() => {
    target[key] = original;
  });
  target[key] = value;
}

describe("#364 — CitationCheckSvc fills in the official text", () => {
  const originalFlag = process.env.USE_JEV_VALIDITY;
  let fetches: { lawId: string; quote: string; ukSection?: string | null }[];
  let fetchResult: SourceText.FetchedOfficialText | null;
  let resolved: { lawId: string | null; ukSection?: string | null };
  let saved: any;
  let existingRow: any;
  let pinpointDetected: boolean;

  beforeEach(() => {
    process.env.USE_JEV_VALIDITY = "false";
    fetches = [];
    fetchResult = { text: PASSAGE, source: "PH_LAW", ref: null, label: "Agabon v. NLRC" };
    resolved = { lawId: "law-1" };
    saved = null;
    existingRow = null;
    pinpointDetected = false;

    stub(CaseAccess, "assertCanEdit", async () => ({}));
    stub(CaseAccess, "resolveTenantCode", async () => "PH");
    stub(CitationCheckSvc, "resolveAuthority", async () => ({
      lawId: resolved.lawId,
      confidence: resolved.lawId ? 0.9 : null,
      authority: resolved.lawId ? { lawId: resolved.lawId, title: "Agabon v. NLRC", jurisUrl: "https://juris.ph/x" } : null,
      ukSection: resolved.ukSection ?? null,
    }));
    stub(SourceText, "fetchOfficialText", async (input: { lawId: string; quote: string; ukSection?: string | null }) => {
      fetches.push({ lawId: input.lawId, quote: input.quote, ukSection: input.ukSection });
      return fetchResult;
    });
    stub(Proposition, "classifyProposition", async () => null);
    stub(Pinpoint, "detectPinpoint", async () => {
      pinpointDetected = true;
      return null;
    });
    stub(CitationCheckRepo, "create", async (_caseId: string, data: any) => (saved = { id: "c-1", ...data }));
    stub(CitationCheckRepo, "findInCase", async () => existingRow);
    stub(CitationCheckRepo, "update", async (_id: string, _caseId: string, data: any) => (saved = { id: "c-1", ...data }));
    stub(OrganizationRepo, "writeAudit", async () => {});
    stub(ManualEditLog, "record", async () => {});
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
    if (originalFlag === undefined) delete process.env.USE_JEV_VALIDITY;
    else process.env.USE_JEV_VALIDITY = originalFlag;
  });

  describe("a new check", () => {
    it("uses the lawyer's pasted text and fetches nothing", async () => {
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "G.R. No. 158693", officialText: PASSAGE });
      expect(fetches).to.have.length(0);
      expect(saved).to.include({ officialText: PASSAGE, officialTextSource: "LAWYER", officialTextRef: null, status: "VALID" });
    });

    it("left empty, fetches the passage from the resolved authority and checks against it", async () => {
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "G.R. No. 158693" });
      expect(fetches).to.deep.equal([{ lawId: "law-1", quote: QUOTE, ukSection: null }]);
      expect(saved).to.include({ officialText: PASSAGE, officialTextSource: "PH_LAW", officialTextRef: null, status: "VALID" });
      expect(saved.notes).to.match(/^Checked against Agabon v\. NLRC\. /);
    });

    it("passes a UK Act's cited section through to the fetch", async () => {
      resolved = { lawId: "law-act", ukSection: "13" };
      fetchResult = { text: PASSAGE, source: "UK_LEGISLATION", ref: "s. 13", label: "Equality Act 2010, s. 13" };
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "s.13 Equality Act 2010" });
      expect(fetches[0]).to.include({ lawId: "law-act", ukSection: "13" });
      expect(saved).to.include({ officialTextSource: "UK_LEGISLATION", officialTextRef: "s. 13" });
    });

    it("a UK judgment's paragraph becomes the pinpoint, with no second search", async () => {
      fetchResult = { text: PASSAGE, source: "UK_JUDGMENT", ref: "para_37", pinpoint: "para. 37", label: "[2022] UKSC 34, para. 37" };
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "[2022] UKSC 34" });
      expect(saved).to.include({ pinpoint: "para. 37", officialTextRef: "para_37" });
      expect(pinpointDetected).to.equal(false);
    });

    it("when the fetch comes back empty, says why it wasn't checked", async () => {
      fetchResult = null;
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "G.R. No. 158693" });
      expect(saved).to.include({ status: "UNVERIFIED", officialText: null, officialTextSource: null });
      expect(saved.notes).to.include("Couldn't load the text of Agabon v. NLRC");
    });

    it("with no resolved authority there's nothing to fetch", async () => {
      resolved = { lawId: null };
      await CitationCheckSvc.check("case-1", "u-1", { quotedText: QUOTE, citedReference: "Some unknown case" });
      expect(fetches).to.have.length(0);
      expect(saved.status).to.equal("UNVERIFIED");
      expect(saved.notes).to.not.include("Couldn't load");
    });
  });

  describe("an edit", () => {
    const autoRow = () => ({
      id: "c-1",
      caseId: "case-1",
      quotedText: QUOTE,
      citedReference: "G.R. No. 158693",
      sourceUrl: null,
      officialText: PASSAGE,
      officialTextSource: "PH_LAW",
      officialTextRef: null,
      pinpoint: null,
    });

    it("a changed quote fetches the passage again for the new quote", async () => {
      existingRow = autoRow();
      await CitationCheckSvc.update("case-1", "c-1", "u-1", { quotedText: "The employer may terminate the employee" });
      expect(fetches).to.have.length(1);
      expect(fetches[0].quote).to.equal("The employer may terminate the employee");
    });

    it("the fetched passage sent back unchanged (the edit form prefills it) stays fetched, with no new fetch", async () => {
      existingRow = autoRow();
      await CitationCheckSvc.update("case-1", "c-1", "u-1", { quotedText: QUOTE, officialText: PASSAGE, pinpoint: null });
      expect(fetches).to.have.length(0);
      expect(saved).to.include({ officialText: PASSAGE, officialTextSource: "PH_LAW" });
    });

    it("text the lawyer edits becomes theirs", async () => {
      existingRow = autoRow();
      await CitationCheckSvc.update("case-1", "c-1", "u-1", { officialText: "The employee has committed serious misconduct, the court held." });
      expect(fetches).to.have.length(0);
      expect(saved).to.include({ officialTextSource: "LAWYER" });
    });

    it("text the lawyer clears is fetched again", async () => {
      existingRow = { ...autoRow(), officialTextSource: "LAWYER" };
      await CitationCheckSvc.update("case-1", "c-1", "u-1", { officialText: "" });
      expect(fetches).to.have.length(1);
      expect(saved).to.include({ officialTextSource: "PH_LAW" });
    });

    it("a lawyer's own text on an older row (no source recorded) is kept on a quote edit", async () => {
      existingRow = { ...autoRow(), officialTextSource: null };
      await CitationCheckSvc.update("case-1", "c-1", "u-1", { quotedText: "The employer may terminate the employee" });
      expect(fetches).to.have.length(0);
      expect(saved).to.include({ officialText: PASSAGE });
    });
  });
});
