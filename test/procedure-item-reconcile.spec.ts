import { expect } from "chai";
import { describe, it } from "mocha";
import { planAiProcedureItems } from "../src/utils/procedure-item-reconcile";

const row = (id: string, label: string, done = false, kind = "TODO", sourceLabel: string | null = null) => ({ id, kind, label, done, sourceLabel });

describe("planAiProcedureItems", () => {
  it("keeps a ticked item that the new run repeats, without recreating it", () => {
    const plan = planAiProcedureItems([row("a", "File the complaint", true)], [{ kind: "TODO", label: "file the complaint", sourceLabel: null }]);
    expect(plan).to.deep.equal({ create: [], update: [], remove: [] });
  });

  it("keeps a ticked item the new run no longer mentions, but drops an open one", () => {
    const plan = planAiProcedureItems([row("done", "Serve summons", true), row("open", "Old idea", false)], []);
    expect(plan.remove).to.deep.equal(["open"]);
  });

  it("creates new labels and refreshes a changed source", () => {
    const plan = planAiProcedureItems([row("a", "Get payroll", false, "TODO", "old.pdf")], [
      { kind: "TODO", label: "Get payroll", sourceLabel: "new.pdf" },
      { kind: "TODO", label: "Subpoena emails", sourceLabel: null },
    ]);
    expect(plan.update).to.deep.equal([{ id: "a", sourceLabel: "new.pdf" }]);
    expect(plan.create.map((i) => i.label)).to.deep.equal(["Subpoena emails"]);
  });

  it("does not cap how many items a case can hold", () => {
    const incoming = Array.from({ length: 250 }, (_, i) => ({ kind: "TODO", label: `Task ${i}`, sourceLabel: null }));
    expect(planAiProcedureItems([], incoming).create).to.have.length(250);
  });
});
