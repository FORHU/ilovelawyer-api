import { expect } from "chai";
import { describe, it } from "mocha";
import { isLawyerEdit } from "../src/utils/finding-lawyer-edit";

describe("isLawyerEdit", () => {
  const row = { label: "No CCTV from the Co-op", detail: null, tag: null };

  it("counts a rating as an edit", () => {
    expect(isLawyerEdit(row, { tag: "MATERIAL" })).to.equal(true);
  });

  it("counts a changed label or a new detail line", () => {
    expect(isLawyerEdit(row, { label: "No CCTV from the Co-op at 18:02" })).to.equal(true);
    expect(isLawyerEdit(row, { detail: "Request the store's footage" })).to.equal(true);
  });

  it("ignores a PATCH that repeats what the row already says", () => {
    expect(isLawyerEdit(row, { label: row.label, detail: null, tag: null })).to.equal(false);
  });

  it("ignores reordering and the notes marker", () => {
    expect(isLawyerEdit(row, {})).to.equal(false);
    expect(isLawyerEdit({ ...row, tag: "MINOR" }, { tag: undefined })).to.equal(false);
  });
});
