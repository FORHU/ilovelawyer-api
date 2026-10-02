/** Citation ranking: the objective signals, the tier rules and Jev batching. No live Jev — the
 * TypeSafe client is monkeypatched, same idiom as weakness-jev.spec.ts. The named-by-user cases are
 * taken from the Brackenmoor Q1 prompt, which names its authorities outright. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  RankableAuthority,
  combineTier,
  compareByTier,
  deterministicSignals,
  isNamedByUser,
  phCourtLevel,
  rankAuthority,
  ukCourtLevel,
  ukInstrument,
} from "../src/utils/citation-rank";
import { batchAuthorities, buildBatch, parseBatch, rateAuthoritiesWithJev } from "../src/utils/citation-rank-jev";

const Q1 =
  'Advise on the prospects of convicting Meridian of corporate manslaughter under s.1 of the Corporate Manslaughter and Corporate Homicide Act 2007, and Mr Ferris of an offence under s.37 HSWA 1974. Explain how the attribution arguments at D16.3 (Bilta; Singularis) bear on it, addressing ss.119 and 120 CJA 2003 and s.3 of the Criminal Procedure Act 1865.';

const auth = (label: string, kind: RankableAuthority["kind"], extra: Partial<RankableAuthority> = {}): RankableAuthority => ({
  id: `/homepage/library/laws/${label}`,
  label,
  kind,
  ...extra,
});

describe("isNamedByUser", () => {
  it("matches a statute by full title and provision", () => {
    expect(isNamedByUser({ label: "Corporate Manslaughter and Corporate Homicide Act 2007, s 1", kind: "legislation" }, Q1)).to.equal(true);
  });
  it("matches a statute by the acronym the user wrote", () => {
    expect(isNamedByUser({ label: "Health and Safety at Work etc. Act 1974, s 37", kind: "legislation" }, Q1)).to.equal(true);
    expect(isNamedByUser({ label: "Criminal Justice Act 2003, s 119", kind: "legislation" }, Q1)).to.equal(true);
    expect(isNamedByUser({ label: "Criminal Justice Act 2003, s 120", kind: "legislation" }, Q1)).to.equal(true);
  });
  it("does not match the right Act with a provision the user never mentioned", () => {
    expect(isNamedByUser({ label: "Corporate Manslaughter and Corporate Homicide Act 2007, s 8", kind: "legislation" }, Q1)).to.equal(false);
    expect(isNamedByUser({ label: "Health and Safety at Work etc. Act 1974, s 3", kind: "legislation" }, Q1)).to.equal(false);
  });
  it("matches a case by either party, with the parentheticals ignored", () => {
    expect(isNamedByUser({ label: "Jetivia SA v Bilta (UK) Ltd (in liquidation) [2015] UKSC 23", kind: "case" }, Q1)).to.equal(true);
    expect(
      isNamedByUser({ label: "Singularis Holdings Ltd (in official liquidation) v Daiwa Capital Markets Europe Ltd [2019] UKSC 50", kind: "case" }, Q1),
    ).to.equal(true);
  });
  it("does not match a case the user never named", () => {
    expect(isNamedByUser({ label: "R v Misra [2004] EWCA Crim 2375", kind: "case" }, Q1)).to.equal(false);
    expect(isNamedByUser({ label: "R v Wood Treatment Ltd [2021] EWCA Crim 618", kind: "case" }, Q1)).to.equal(false);
  });
  it("never matches on a generic party word alone", () => {
    expect(isNamedByUser({ label: "Royal Mail Group Ltd v Jhuti [2019] UKSC 55", kind: "case" }, "the royal family wants advice")).to.equal(false);
    expect(isNamedByUser({ label: "Royal Mail Group Ltd v Jhuti [2019] UKSC 55", kind: "case" }, "does Jhuti apply to my dismissal?")).to.equal(true);
  });
  it("is false for an empty message", () => {
    expect(isNamedByUser({ label: "R v Misra [2004] EWCA Crim 2375", kind: "case" }, "  ")).to.equal(false);
  });
});

describe("court level and instrument", () => {
  it("orders the UK courts from the source URL", () => {
    const lvl = (p: string) => ukCourtLevel(`https://caselaw.nationalarchives.gov.uk${p}`)?.level;
    expect(lvl("/uksc/2015/23")).to.equal(1);
    expect(lvl("/ewca/crim/2004/2375")).to.equal(2);
    expect(lvl("/ewhc/tcc/2018/123")).to.equal(3);
    expect(lvl("/eat/2019/12")).to.equal(4);
    expect(ukCourtLevel("not a url")).to.equal(null);
    expect(ukCourtLevel(null)).to.equal(null);
  });
  it("puts En Banc above a Division, whatever the case of juris.ph's value", () => {
    expect(phCourtLevel("En Banc")?.level).to.equal(1);
    expect(phCourtLevel("FIRST DIVISION")?.level).to.equal(2);
    expect(phCourtLevel("Third Division")?.level).to.equal(2);
    expect(phCourtLevel("")).to.equal(null);
    expect(phCourtLevel(undefined)).to.equal(null);
  });
  it("reads the instrument type from a legislation URL", () => {
    expect(ukInstrument("https://www.legislation.gov.uk/ukpga/1974/37/section/37")).to.equal("ukpga");
    expect(ukInstrument("https://www.legislation.gov.uk/uksi/2008/1277/regulation/3")).to.equal("uksi");
  });
});

describe("combineTier", () => {
  const none = { namedByUser: false, courtLevel: null, courtName: null, instrument: null };
  const v = (choice: "HIGH" | "MEDIUM" | "LOW", topProbability = 0.9) => ({ choice, topProbability });

  it("is UNRATED, never a guess, when Jev is off or silent", () => {
    expect(combineTier(none, null).tier).to.equal("UNRATED");
    expect(combineTier(none, { relevance: null, importance: null }).tier).to.equal("UNRATED");
  });
  it("treats a verdict under the probability floor as missing", () => {
    expect(combineTier(none, { relevance: v("HIGH", 0.4), importance: v("HIGH") }).tier).to.equal("UNRATED");
  });
  it("is HIGH only when relevance is HIGH and importance is not LOW", () => {
    expect(combineTier(none, { relevance: v("HIGH"), importance: v("HIGH") }).tier).to.equal("HIGH");
    expect(combineTier(none, { relevance: v("HIGH"), importance: v("MEDIUM") }).tier).to.equal("HIGH");
    expect(combineTier(none, { relevance: v("HIGH"), importance: v("LOW") }).tier).to.equal("MEDIUM");
    expect(combineTier(none, { relevance: v("HIGH"), importance: null }).tier).to.equal("HIGH");
  });
  it("is LOW when relevance is LOW, however important Jev thinks it is", () => {
    expect(combineTier(none, { relevance: v("LOW"), importance: v("HIGH") }).tier).to.equal("LOW");
  });
  it("is MEDIUM for a MEDIUM relevance", () => {
    expect(combineTier(none, { relevance: v("MEDIUM"), importance: v("HIGH") }).tier).to.equal("MEDIUM");
  });
  it("lets the user naming an authority override Jev, and rates it even with Jev off", () => {
    const named = { ...none, namedByUser: true };
    expect(combineTier(named, { relevance: v("LOW"), importance: v("LOW") }).tier).to.equal("MEDIUM");
    expect(combineTier(named, null).tier).to.equal("HIGH");
    expect(combineTier(named, null).reason).to.include("You named it");
  });
  it("keeps the reason to facts: empty when there are none, the court when known", () => {
    expect(combineTier(none, { relevance: v("HIGH"), importance: v("HIGH") }).reason).to.equal("");
    expect(combineTier({ ...none, courtName: "Court of Appeal" }, { relevance: v("HIGH"), importance: v("HIGH") }).reason).to.equal("Court of Appeal");
  });
  it("never claims the authority is correct or the advice sound", () => {
    const r = combineTier({ ...none, courtName: "Court of Appeal" }, { relevance: v("HIGH"), importance: v("HIGH") });
    expect(r.reason).to.not.match(/correct|valid|sound|good law/i);
  });
});

describe("rankAuthority and compareByTier", () => {
  it("sorts by tier, then by the higher court, and puts UNRATED last", () => {
    const ca = auth("R v A [2020] EWCA Crim 1", "case", { sourceUrl: "https://caselaw.nationalarchives.gov.uk/ewca/crim/2020/1" });
    const sc = auth("B v C [2019] UKSC 2", "case", { sourceUrl: "https://caselaw.nationalarchives.gov.uk/uksc/2019/2" });
    const un = auth("D v E [2018] EWHC 3", "case");
    const hi = { relevance: { choice: "HIGH" as const, topProbability: 0.9 }, importance: { choice: "HIGH" as const, topProbability: 0.9 } };
    const ranked = [rankAuthority(un, "x", null), rankAuthority(ca, "x", hi), rankAuthority(sc, "x", hi)].sort(compareByTier);
    expect(ranked.map((r) => r.id)).to.deep.equal([sc.id, ca.id, un.id]);
  });
  it("carries the signals it computed", () => {
    const r = rankAuthority(auth("R v Misra [2004] EWCA Crim 2375", "case", { sourceUrl: "https://caselaw.nationalarchives.gov.uk/ewca/crim/2004/2375" }), Q1, null);
    expect(r.signals.namedByUser).to.equal(false);
    expect(r.signals.courtLevel).to.equal(2);
    expect(deterministicSignals(auth("x", "legislation", { sourceUrl: "https://www.legislation.gov.uk/ukpga/1974/37" }), "").instrument).to.equal("ukpga");
  });
});

describe("batchAuthorities", () => {
  const many = (n: number, textChars = 1500) => Array.from({ length: n }, (_, i) => auth(`Authority ${i}`, "case", { text: "x".repeat(textChars) }));
  it("keeps everything in one batch when it fits, preserving order", () => {
    const b = batchAuthorities(many(10), 500);
    expect(b).to.have.length(1);
    expect(b[0].map((a) => a.label)).to.deep.equal(many(10).map((a) => a.label));
  });
  it("splits when the token budget would be exceeded, with nothing lost or reordered", () => {
    const all = many(200);
    const b = batchAuthorities(all, 500, 10_000);
    expect(b.length).to.be.greaterThan(1);
    expect(b.flat().map((a) => a.id)).to.deep.equal(all.map((a) => a.id));
  });
  it("puts one oversized authority in a batch of its own rather than dropping it", () => {
    const b = batchAuthorities(many(3, 9000), 500, 1000);
    expect(b.flat()).to.have.length(3);
  });
});

describe("buildBatch", () => {
  it("never includes the answer, and puts each authority in state once", () => {
    const { state, questions } = buildBatch("My driver question", "Case: R v X", [auth("R v Misra [2004] EWCA Crim 2375", "case", { text: "Gross negligence manslaughter elements." })]);
    expect(Object.keys(state)).to.have.members(["message", "caseContext", "authority_0"]);
    expect(state.authority_0).to.include("Gross negligence manslaughter elements.");
    expect(Object.keys(questions)).to.have.members(["rel_0", "imp_0"]);
    expect(JSON.stringify(questions)).to.not.include("Gross negligence manslaughter elements.");
  });
});

describe("parseBatch", () => {
  it("reads the probability of the chosen option, and leaves a malformed answer null", () => {
    const a = [auth("A", "case"), auth("B", "case")];
    const m = parseBatch(a, {
      rel_0: { choice: "HIGH", confidence: 0.1, probabilities: { HIGH: 0.8, MEDIUM: 0.1, LOW: 0.1 } },
      imp_0: { choice: "BANANA", confidence: 0.9 },
      rel_1: { choice: "LOW", confidence: 0.7 },
    });
    expect(m.get(a[0].id)?.relevance).to.deep.equal({ choice: "HIGH", topProbability: 0.8 });
    expect(m.get(a[0].id)?.importance).to.equal(null);
    expect(m.get(a[1].id)?.relevance).to.deep.equal({ choice: "LOW", topProbability: 0.7 });
    expect(m.get(a[1].id)?.importance).to.equal(null);
  });
});

describe("rateAuthoritiesWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let calls: any[];
  let handler: (req: any) => Promise<unknown>;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    process.env.USE_JEV_CITATION_RANK = "true";
    calls = [];
    (TypeSafeClient.prototype as any).systemOne = async (req: any) => {
      calls.push(req);
      return handler(req);
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    delete process.env.USE_JEV_CITATION_RANK;
  });
  const answerAll = (level: string) => async (req: any) => ({
    answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: level, confidence: 0.9, probabilities: { [level]: 0.9 } }])),
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("returns null when the flag is off and makes no call", async () => {
    delete process.env.USE_JEV_CITATION_RANK;
    expect(await rateAuthoritiesWithJev("msg", [auth("A", "case")])).to.equal(null);
    expect(calls).to.have.length(0);
  });
  it("rates every authority in one call", async () => {
    handler = answerAll("HIGH");
    const a = [auth("A", "case"), auth("B", "legislation")];
    const out = await rateAuthoritiesWithJev("My question", a);
    expect(calls).to.have.length(1);
    expect(out?.get(a[1].id)?.relevance?.choice).to.equal("HIGH");
  });
  it("fails open: a failing call leaves authorities unrated and never throws", async () => {
    handler = async () => {
      throw new Error("boom");
    };
    const a = [auth("A", "case")];
    const out = await rateAuthoritiesWithJev("My question", a);
    expect(out?.get(a[0].id)).to.equal(undefined);
    expect(combineTier({ namedByUser: false, courtLevel: null, courtName: null, instrument: null }, out?.get(a[0].id) ?? null).tier).to.equal("UNRATED");
  });
  it("keeps the batches that worked when another one fails", async () => {
    let n = 0;
    handler = async (req) => {
      if (n++ === 0) throw new Error("first batch down");
      return answerAll("MEDIUM")(req);
    };
    const all = Array.from({ length: 120 }, (_, i) => auth(`Authority ${i}`, "case", { text: "x".repeat(1500) }));
    const out = await rateAuthoritiesWithJev("My question", all);
    expect(calls.length).to.be.greaterThan(1);
    expect(out!.size).to.be.greaterThan(0);
    expect(out!.size).to.be.lessThan(all.length);
  });
  it("returns an empty map for an empty message without calling Jev", async () => {
    handler = answerAll("HIGH");
    expect((await rateAuthoritiesWithJev("   ", [auth("A", "case")]))?.size).to.equal(0);
    expect(calls).to.have.length(0);
  });
});
