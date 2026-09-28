/** The lawyer's hand edits to the case mind map reach chat-wonder: lawyerChangesSince replays the
 * versions since the build (made here with the real edit functions, so ids behave as in the app),
 * formatLawyerChanges is what every case chat turn carries, and formatMindMapOutline is what a map
 * request carries. No database: MindMapRepo is stubbed for the service-level tests. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { MindMapItem, normalizeMindMap } from "../src/utils/response-parser";
import { appendMindMapChildren, deleteMindMapNode, findMindMapNode, renameMindMapNode } from "../src/utils/mind-map-tree";
import {
  formatLawyerChanges,
  formatMindMapOutline,
  hasLawyerChanges,
  lawyerChangesSince,
} from "../src/utils/mind-map-lawyer-changes";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import MindMapRepo from "../src/repositories/mind-map.repository";
import CaseRepo from "../src/repositories/case.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import DocumentRepo from "../src/repositories/document.repository";

const built = normalizeMindMap({
  label: "Cruz v. Reyes",
  children: [
    { id: "legalBasis", label: "Legal Basis", children: [{ label: "Breach of the note" }, { label: "Unjust enrichment" }] },
    { id: "keyFacts", label: "Key Facts", children: [{ label: "Loan of 500,000", children: [{ label: "Signed 3 March" }] }] },
    { id: "remedies", label: "Remedies", children: [] },
    { id: "risks", label: "Risks", children: [{ label: "Prescription" }] },
    { id: "nextSteps", label: "Next Steps", children: [] },
  ],
})!;

/** Label → id on a tree, so tests don't hard-code path ids. */
const idOf = (tree: MindMapItem, label: string): string => {
  const walk = (n: MindMapItem): string | null => (n.label === label ? n.id : n.children.map(walk).find(Boolean) ?? null);
  const id = walk(tree);
  if (!id) throw new Error(`no node "${label}"`);
  return id;
};
const add = (tree: MindMapItem, parentLabel: string, label: string, description?: string) =>
  appendMindMapChildren(tree, idOf(tree, parentLabel), [description ? { label, description } : { label }])!;
const rename = (tree: MindMapItem, from: string, label: string) => renameMindMapNode(tree, idOf(tree, from), { label })!;
const remove = (tree: MindMapItem, label: string) => deleteMindMapNode(tree, idOf(tree, label))!;

/** Build + the given edits as "edit" versions, oldest first — what listCaseVersionsSinceBuild returns. */
function versionsOf(...steps: ((t: MindMapItem) => MindMapItem)[]) {
  const versions: { reason: string; data: MindMapItem }[] = [{ reason: "auto", data: built }];
  for (const step of steps) versions.push({ reason: "edit", data: step(versions[versions.length - 1].data) });
  return versions;
}
const last = (v: { data: MindMapItem }[]) => v[v.length - 1].data;

describe("the lawyer's own mind map changes", () => {
  describe("lawyerChangesSince", () => {
    it("finds nothing on a map that was only built", () => {
      expect(hasLawyerChanges(lawyerChangesSince(versionsOf()))).to.equal(false);
    });

    it("finds an added point, a reworded one and a removed one", () => {
      const v = versionsOf(
        (t) => add(t, "Remedies", "Sum of money", "Principal plus interest"),
        (t) => rename(t, "Prescription", "Prescription: filed within 10 years"),
        (t) => remove(t, "Unjust enrichment"),
      );
      const c = lawyerChangesSince(v);
      expect([...c.added].map((id) => findMindMapNode(last(v), id)!.node.label)).to.deep.equal(["Sum of money"]);
      expect([...c.edited].map((id) => findMindMapNode(last(v), id)!.node.label)).to.deep.equal(["Prescription: filed within 10 years"]);
      expect(c.removed).to.deep.equal([{ label: "Unjust enrichment", path: ["Legal Basis"] }]);
    });

    it("names only the top of a deleted branch", () => {
      const c = lawyerChangesSince(versionsOf((t) => remove(t, "Loan of 500,000")));
      expect(c.removed).to.deep.equal([{ label: "Loan of 500,000", path: ["Key Facts"] }]);
    });

    it("keeps a point the lawyer added and then reworded as added, not edited", () => {
      const v = versionsOf((t) => add(t, "Remedies", "Damages"), (t) => rename(t, "Damages", "Moral damages"));
      const c = lawyerChangesSince(v);
      expect(c.added.size).to.equal(1);
      expect(c.edited.size).to.equal(0);
    });

    it("forgets a point the lawyer added and then deleted again", () => {
      const c = lawyerChangesSince(versionsOf((t) => add(t, "Remedies", "Damages"), (t) => remove(t, "Damages")));
      expect(hasLawyerChanges(c)).to.equal(false);
    });

    it("drops edits under a branch the lawyer later deleted", () => {
      const c = lawyerChangesSince(
        versionsOf((t) => rename(t, "Signed 3 March", "Signed 3 March 2025"), (t) => remove(t, "Loan of 500,000")),
      );
      expect(c.edited.size).to.equal(0);
      expect(c.removed.map((r) => r.label)).to.deep.equal(["Loan of 500,000"]);
    });

    it("doesn't count AI expansions or Jev checks as the lawyer's changes", () => {
      const expanded = add(built, "Remedies", "Written by the model");
      const c = lawyerChangesSince([
        { reason: "auto", data: built },
        { reason: "expand", data: expanded },
        { reason: "check", data: expanded },
        { reason: "edit", data: rename(expanded, "Prescription", "Laches") },
      ]);
      expect([...c.added]).to.deep.equal([]);
      expect(c.edited.size).to.equal(1);
    });
  });

  describe("what chat-wonder is sent", () => {
    const v = versionsOf(
      (t) => add(t, "Remedies", "Sum of money", "Principal plus interest"),
      (t) => rename(t, "Prescription", "Laches"),
      (t) => remove(t, "Unjust enrichment"),
    );
    const changes = lawyerChangesSince(v);

    it("every case turn: only the changes, each with where it sits", () => {
      const text = formatLawyerChanges(last(v), changes);
      expect(text).to.contain("THE LAWYER'S OWN CHANGES");
      expect(text).to.contain("Added by the lawyer:\n- Remedies › Sum of money: Principal plus interest");
      expect(text).to.contain("Reworded by the lawyer (as it reads now):\n- Risks › Laches");
      expect(text).to.contain("Removed by the lawyer:\n- Legal Basis › Unjust enrichment");
      // Untouched points aren't repeated on every turn.
      expect(text).to.not.contain("Breach of the note");
    });

    it("sends nothing on a turn when the lawyer hasn't changed the map", () => {
      expect(formatLawyerChanges(built, lawyerChangesSince(versionsOf()))).to.equal("");
    });

    it("a map request: the whole map, the changes marked, the removed points first", () => {
      const text = formatMindMapOutline(last(v), changes);
      expect(text).to.contain("- Breach of the note");
      expect(text).to.contain("  - Sum of money: Principal plus interest [added by lawyer]");
      expect(text).to.contain("  - Laches [reworded by lawyer]");
      expect(text.indexOf("Removed by the lawyer:")).to.be.lessThan(text.indexOf("- Legal Basis"));
    });

    it("cuts a long outline on a line boundary and says so", () => {
      const text = formatMindMapOutline(last(v), changes, 400);
      expect(text.length).to.be.at.most(400 + "…(cut for length)".length);
      expect(text.endsWith("…(cut for length)")).to.equal(true);
      expect(text).to.contain("Unjust enrichment");
    });
  });

  describe("CaseMindMapSvc", () => {
    const originals = {
      findCaseMap: MindMapRepo.findCaseMap,
      versions: MindMapRepo.listCaseVersionsSinceBuild,
      header: CaseRepo.findPromptHeader,
      findings: CaseFindingRepo.list,
      timeline: CaseTimelineRepo.list,
      procedure: ProceduralDeadlineRepo.listProcedureItems,
      documents: DocumentRepo.listAllByCase,
    };
    const v = versionsOf((t) => add(t, "Remedies", "Sum of money"));
    let map: { id: string; data: MindMapItem; retiredAt: Date | null } | null;

    beforeEach(() => {
      map = { id: "map-1", data: last(v), retiredAt: null };
      MindMapRepo.findCaseMap = (async () => map) as any;
      MindMapRepo.listCaseVersionsSinceBuild = (async () => v) as any;
      CaseRepo.findPromptHeader = (async () => ({ caseName: "Cruz v. Reyes", actionType: null, jurisdiction: null })) as any;
      CaseFindingRepo.list = (async () => []) as any;
      CaseTimelineRepo.list = (async () => []) as any;
      ProceduralDeadlineRepo.listProcedureItems = (async () => []) as any;
      DocumentRepo.listAllByCase = (async () => []) as any;
    });

    afterEach(() => {
      MindMapRepo.findCaseMap = originals.findCaseMap;
      MindMapRepo.listCaseVersionsSinceBuild = originals.versions;
      CaseRepo.findPromptHeader = originals.header;
      CaseFindingRepo.list = originals.findings;
      CaseTimelineRepo.list = originals.timeline;
      ProceduralDeadlineRepo.listProcedureItems = originals.procedure;
      DocumentRepo.listAllByCase = originals.documents;
    });

    it("lawyerChangesContext gives a chat turn the lawyer's changes", async () => {
      expect(await CaseMindMapSvc.lawyerChangesContext("case-1")).to.contain("- Remedies › Sum of money");
    });

    it("lawyerChangesContext is empty with no map, or a retired one", async () => {
      map = null;
      expect(await CaseMindMapSvc.lawyerChangesContext("case-1")).to.equal("");
      map = { id: "map-1", data: last(v), retiredAt: new Date() };
      expect(await CaseMindMapSvc.lawyerChangesContext("case-1")).to.equal("");
    });

    it("buildChatContext adds the current map, with the lawyer's point marked, after the case digest", async () => {
      const text = await CaseMindMapSvc.buildChatContext("case-1");
      expect(text.indexOf("Case: Cruz v. Reyes")).to.be.lessThan(text.indexOf("THE CASE'S CURRENT STRATEGY MAP"));
      expect(text).to.contain("- Sum of money [added by lawyer]");
    });
  });
});
