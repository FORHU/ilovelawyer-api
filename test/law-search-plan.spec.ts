import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import LawSvc from "../src/services/law.service";
import LawRepo from "../src/repositories/law.repository";

// LawSvc.search wired to planPhSearch — DB and juris.ph are both stubbed, so this checks which
// queries get run and how results are combined, not the stored data.

type Item = { id: string; ra_number?: string; case_number?: string; score?: number; title?: string };
type Stubbable = Record<string, unknown>;

describe("LawSvc.search — query planning", () => {
  const realFetch = globalThis.fetch;
  const repo = LawRepo as unknown as Stubbable;
  const svc = LawSvc as unknown as Stubbable;
  const originals: Record<string, unknown> = {};
  let fetched: string[];
  let localCalls: Array<{ terms: string[]; number?: { field: string; digits: string } }>;
  let localRows: unknown[];
  let remote: (q: string) => Item[] | "down";

  beforeEach(() => {
    fetched = [];
    localCalls = [];
    localRows = [];
    remote = () => [];
    for (const k of ["localSearch", "resolvePhTenantId", "updateScore"]) originals[`repo.${k}`] = repo[k];
    for (const k of ["storeAndAnnotate", "toStoredResult"]) originals[`svc.${k}`] = svc[k];

    repo.localSearch = async (p: { terms: string[]; number?: { field: string; digits: string } }) => {
      localCalls.push({ terms: p.terms, number: p.number });
      return localRows;
    };
    repo.resolvePhTenantId = async () => "tenant";
    repo.updateScore = async () => undefined;
    svc.storeAndAnnotate = async (raw: Item[]) => raw.map((it) => ({ ...it, stored_id: it.id, stored: true }));
    svc.toStoredResult = () => ({ stored: true });

    globalThis.fetch = (async (url: string) => {
      const q = new URL(url).searchParams.get("q") as string;
      fetched.push(q);
      const out = remote(q);
      if (out === "down") throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ items: out, meta: { query: q } }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ["localSearch", "resolvePhTenantId", "updateScore"]) repo[k] = originals[`repo.${k}`];
    for (const k of ["storeAndAnnotate", "toStoredResult"]) svc[k] = originals[`svc.${k}`];
  });

  it("an ordinary query behaves as before: one local lookup, one juris.ph call", async () => {
    remote = () => [{ id: "a" }];
    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "violence against women", limit: 5 });
    expect(localCalls).to.deep.equal([{ terms: ["violence against women"], number: undefined }]);
    expect(fetched).to.deep.equal(["violence against women"]);
    expect(res.meta.source).to.equal("juris.ph");
    expect(res.meta.query).to.equal("violence against women");
  });

  it("VAWC runs every variant upstream (never the acronym) and puts RA 9262 first", async () => {
    remote = (q) =>
      q === "RA 9262"
        ? [{ id: "noise-1", ra_number: "8796", score: 0.9 }]
        : q === "Republic Act No. 9262"
          ? [{ id: "ra9262", ra_number: "9262", score: 0.4 }, { id: "noise-1", ra_number: "8796", score: 0.9 }]
          : [{ id: "amend", ra_number: "10398", score: 0.8 }];

    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "VAWC", limit: 5 });

    expect(fetched).to.have.members([
      "Republic Act No. 9262",
      "R.A. No. 9262",
      "RA 9262",
      "Anti-Violence Against Women and Their Children Act of 2004",
    ]);
    expect(fetched).to.not.include("VAWC");
    expect(localCalls[0].number).to.deep.equal({ field: "raNumber", digits: "9262" });
    expect(res.items.map((i) => i.id)).to.deep.equal(["ra9262", "noise-1", "amend"]);
    expect(res.meta.query).to.equal("VAWC");
    expect(res.meta.count).to.equal(3);
  });

  it("trims a merged result to the limit, exact number kept", async () => {
    remote = (q) =>
      q === "RA 9160"
        ? [{ id: "ra9160", ra_number: "9160" }]
        : [{ id: "x1", ra_number: "1" }, { id: "x2", ra_number: "2" }, { id: "x3", ra_number: "3" }];
    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "AMLA", limit: 2 });
    expect(res.items.map((i) => i.id)).to.deep.equal(["ra9160", "x1"]);
  });

  it("a stored act that merely cites RA 9262 does not stop the lookup", async () => {
    localRows = [{ raNumber: "19262" }, { raNumber: "R.A. No. 10398 (amending R.A. No. 9262)" }];
    remote = () => [{ id: "ra9262", ra_number: "9262" }];
    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "RA 9262", limit: 5 });
    expect(fetched.length).to.equal(3);
    expect(res.items[0].id).to.equal("ra9262");
  });

  it("serves the stored row, with no upstream call, when its number matches exactly", async () => {
    localRows = [{ raNumber: "No. 9262" }];
    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "R.A. No. 9262", limit: 5 });
    expect(res).to.deep.equal({ stored: true });
    expect(fetched).to.deep.equal([]);
  });

  it("looks up a G.R. number in every typed form via caseNumber", async () => {
    remote = (q) => (q === "203335" ? [{ id: "disini", case_number: "G.R. No. 203335" }] : []);
    const res = await LawSvc.search({ category: "JURISPRUDENCE", q: "GR# 203335", limit: 5 });
    expect(localCalls[0].number).to.deep.equal({ field: "caseNumber", digits: "203335" });
    expect(fetched).to.have.members(["G.R. No. 203335", "203335"]);
    expect(res.items.map((i) => i.id)).to.deep.equal(["disini"]);
  });

  it("EO/PD/AO/MO return an empty result with a notice and touch neither the DB nor juris.ph", async () => {
    for (const [q, label] of [
      ["PD 442", "Presidential Decree No. 442"],
      ["EO 209", "Executive Order No. 209"],
      ["AO 25", "Administrative Order No. 25"],
      ["MO 32", "Memorandum Order No. 32"],
    ]) {
      const res = await LawSvc.search({ category: "REPUBLIC_ACT", q, limit: 5 });
      expect(res.items).to.deep.equal([]);
      expect(res.meta).to.include({ count: 0, source: "none", query: q });
      expect(res.notice).to.contain(label);
    }
    expect(fetched).to.deep.equal([]);
    expect(localCalls).to.deep.equal([]);
  });

  it("uses the variants that succeeded when some upstream calls fail", async () => {
    remote = (q) => (q === "R.A. No. 9262" ? [{ id: "ra9262", ra_number: "9262" }] : "down");
    const res = await LawSvc.search({ category: "REPUBLIC_ACT", q: "RA 9262", limit: 5 });
    expect(res.items.map((i) => i.id)).to.deep.equal(["ra9262"]);
  });

  it("502s when juris.ph is unreachable for every variant and nothing is stored", async () => {
    remote = () => "down";
    let status: number | undefined;
    try {
      await LawSvc.search({ category: "REPUBLIC_ACT", q: "VAWC", limit: 5 });
    } catch (err) {
      status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
    }
    expect(status).to.equal(502);
    expect(fetched.length).to.equal(4);
  });
});
