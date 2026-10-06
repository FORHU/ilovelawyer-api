import { expect } from "chai";
import { describe, it } from "mocha";
import { courtCodeFromSlug } from "../src/legal/law-source/uk/uk-law-mappers";

describe("courtCodeFromSlug", () => {
  it("upper-cases a single-segment court", () => {
    expect(courtCodeFromSlug("uksc/2024/12")).to.equal("UKSC");
  });

  it("title-cases word-abbreviation divisions", () => {
    expect(courtCodeFromSlug("ewca/civ/2023/450")).to.equal("EWCA (Civ)");
    expect(courtCodeFromSlug("ewhc/admlty/2024/3")).to.equal("EWHC (Admlty)");
  });

  it("keeps initialism divisions in capitals", () => {
    expect(courtCodeFromSlug("ewhc/kb/2024/1")).to.equal("EWHC (KB)");
    expect(courtCodeFromSlug("ewhc/tcc/2024/1")).to.equal("EWHC (TCC)");
    expect(courtCodeFromSlug("ewhc/ipec/2024/1")).to.equal("EWHC (IPEC)");
    expect(courtCodeFromSlug("ewhc/scco/2024/1")).to.equal("EWHC (SCCO)");
    expect(courtCodeFromSlug("ukut/iac/2024/1")).to.equal("UKUT (IAC)");
    expect(courtCodeFromSlug("ukut/aac/2024/1")).to.equal("UKUT (AAC)");
    expect(courtCodeFromSlug("ukut/tcc/2024/1")).to.equal("UKUT (TCC)");
    expect(courtCodeFromSlug("ukut/lc/2024/1")).to.equal("UKUT (LC)");
    expect(courtCodeFromSlug("ukftt/tc/2024/1")).to.equal("UKFTT (TC)");
    expect(courtCodeFromSlug("ukftt/grc/2024/1")).to.equal("UKFTT (GRC)");
  });
});
