import { expect } from "chai";
import { describe, it } from "mocha";
import { sectionStatus, type SectionStatusInput } from "../src/utils/client-overview-status";

const base: SectionStatusInput = {
  pane: "findings",
  runningPanesDone: null,
  generated: null,
  lastRunFailed: false,
  hasContent: false,
};
const generated = (over: Partial<NonNullable<SectionStatusInput["generated"]>> = {}) => ({ panes: {}, stale: false, ...over });

describe("sectionStatus", () => {
  it("is RUNNING while the live job hasn't finished this section's pane, whatever was there before", () => {
    expect(sectionStatus({ ...base, runningPanesDone: [] })).to.equal("RUNNING");
    expect(sectionStatus({ ...base, runningPanesDone: ["strategy"], generated: generated({ stale: true }), hasContent: true })).to.equal("RUNNING");
  });

  it("shows a pane this run already finished as READY, or EMPTY when it found nothing", () => {
    expect(sectionStatus({ ...base, runningPanesDone: ["findings"], hasContent: true })).to.equal("READY");
    expect(sectionStatus({ ...base, runningPanesDone: ["findings"], hasContent: false })).to.equal("EMPTY");
  });

  it("is EMPTY before anything has ever been generated", () => {
    expect(sectionStatus(base)).to.equal("EMPTY");
  });

  it("is FAILED when nothing has been generated and the last run failed", () => {
    expect(sectionStatus({ ...base, lastRunFailed: true })).to.equal("FAILED");
  });

  it("ignores a failed run once content exists — that run left the last good content in place", () => {
    expect(sectionStatus({ ...base, generated: generated(), lastRunFailed: true, hasContent: true })).to.equal("READY");
  });

  it("is FAILED when the last run's pane for this section failed, ahead of STALE", () => {
    expect(sectionStatus({ ...base, generated: generated({ panes: { findings: "FAILED" } }), hasContent: true })).to.equal("FAILED");
    expect(sectionStatus({ ...base, generated: generated({ panes: { findings: "FAILED" }, stale: true }), hasContent: true })).to.equal("FAILED");
  });

  it("is STALE when the documents changed since, even with nothing to show — a new document can add some", () => {
    expect(sectionStatus({ ...base, generated: generated({ stale: true }), hasContent: true })).to.equal("STALE");
    expect(sectionStatus({ ...base, generated: generated({ stale: true }), hasContent: false })).to.equal("STALE");
  });

  it("is EMPTY when the last run found nothing for this section, READY when it found something", () => {
    expect(sectionStatus({ ...base, generated: generated({ panes: { findings: "DONE" } }), hasContent: false })).to.equal("EMPTY");
    expect(sectionStatus({ ...base, generated: generated({ panes: { findings: "DONE" } }), hasContent: true })).to.equal("READY");
  });

  it("only reads this section's own pane outcome", () => {
    expect(sectionStatus({ ...base, generated: generated({ panes: { strategy: "FAILED" } }), hasContent: true })).to.equal("READY");
  });
});
