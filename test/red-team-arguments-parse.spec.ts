import { expect } from "chai";
import { describe, it } from "mocha";
import { extractRedTeamArguments, resolveSource, RedTeamSourceItem } from "../src/utils/red-team-arguments-parse";

const items: RedTeamSourceItem[] = [
  { kind: "WEAKNESS", label: "No written protest between 4 and 11 August" },
  { kind: "TIMELINE", label: "AWOL from 4 August" },
  { kind: "CONTRADICTION", label: "I was told not to come in until further notice" },
  { kind: "WITNESS", label: "Ana" },
  { kind: "PARTY", label: "Northbridge Logistics Inc." },
];
const parties = ["Juan Cruz", "Northbridge Logistics Inc."];
const wrap = (json: string) => `### 1. Procedural...\n[ARGUMENTS]\n${json}\n[/ARGUMENTS]\n[CLAIMS][][/CLAIMS]`;
const arg = (over: Record<string, unknown>) =>
  JSON.stringify({ title: "T", gist: "G", strength: "STRONG", impact: 5, source: "AWOL from 4 August", reasoning: "R", ...over });

describe("resolveSource", () => {
  it("matches exactly, ignoring case, whitespace and wrapping quotes", () => {
    expect(resolveSource('"awol  from 4 August"', items)?.kind).to.equal("TIMELINE");
  });

  it("matches a bullet copied with its date prefix", () => {
    expect(resolveSource("2024-08-04 — AWOL from 4 August", items)?.label).to.equal("AWOL from 4 August");
  });

  it("matches part of a long excerpt, but not a short fragment", () => {
    expect(resolveSource("told not to come in until further", items)?.kind).to.equal("CONTRADICTION");
    expect(resolveSource("not to come", items)).to.equal(null);
  });

  it("does not match a label shorter than the containment floor", () => {
    expect(resolveSource("Banana republic argument", items)).to.equal(null);
  });

  it("returns null for an invented source", () => {
    expect(resolveSource("The employee handbook section 9", items)).to.equal(null);
  });
});

describe("extractRedTeamArguments", () => {
  it("parses, resolves sources to the case item and ranks by impact", () => {
    const out = extractRedTeamArguments(
      wrap(
        `{"opponent":"northbridge logistics inc.","riskOfLoss":25,"arguments":[${arg({ title: "Weak one", strength: "weak", impact: -5 })},${arg({ title: "Strong one", impact: 8, source: "No written protest between 4 and 11 August" })}]}`,
      ),
      items,
      parties,
    )!;
    expect(out.opponent).to.equal("Northbridge Logistics Inc.");
    expect(out.riskOfLoss).to.equal(25);
    expect(out.arguments.map((a) => a.title)).to.deep.equal(["Strong one", "Weak one"]);
    expect(out.arguments[0].source).to.deep.equal(items[0]);
    expect(out.arguments[1].strength).to.equal("WEAK");
  });

  it("drops arguments with an unresolvable source, bad strength or no impact", () => {
    const out = extractRedTeamArguments(
      wrap(
        `{"arguments":[${arg({ source: "Invented fact" })},${arg({ strength: "DEVASTATING" })},${arg({ impact: "lots" })},${arg({ title: "Kept" })}]}`,
      ),
      items,
      parties,
    )!;
    expect(out.arguments.map((a) => a.title)).to.deep.equal(["Kept"]);
  });

  it("clamps impact and risk, and nulls an opponent that isn't a party", () => {
    const out = extractRedTeamArguments(wrap(`{"opponent":"Someone Else","riskOfLoss":140,"arguments":[${arg({ impact: 40 })}]}`), items, parties)!;
    expect(out.opponent).to.equal(null);
    expect(out.riskOfLoss).to.equal(100);
    expect(out.arguments[0].impact).to.equal(10);
  });

  it("dedupes by title", () => {
    const out = extractRedTeamArguments(wrap(`{"arguments":[${arg({ title: "Same" })},${arg({ title: "same " })}]}`), items, parties)!;
    expect(out.arguments).to.have.length(1);
  });

  it("returns undefined without a block or with a non-object payload", () => {
    expect(extractRedTeamArguments("just prose", items, parties)).to.equal(undefined);
    expect(extractRedTeamArguments(wrap("[1,2]"), items, parties)).to.equal(undefined);
  });
});
