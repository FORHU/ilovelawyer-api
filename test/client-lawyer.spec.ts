/** ClientLawyerSvc — the client app's lawyer marketplace (GET /api/client/lawyers): verified lawyers
 * taking requests, filtered by area, jurisdiction, consultation fee, language and search, and sorted.
 *
 * No live Postgres: repos are monkeypatched on their CommonJS module objects, same idiom as
 * test/client-request-matching.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientLawyerSvc from "../src/services/client-lawyer.service";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import CaseAreaSvc from "../src/services/case-area.service";
import { listClientLawyersSchema, type ListClientLawyersQuery } from "../src/validation/client-lawyer.validation";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const area = (name: string, caseArea: string | null, isActive = true) => ({ id: name, name, caseArea, isActive, sortOrder: 0 });

function lawyer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: id,
    bio: "",
    languages: ["English"],
    firstConsultationFeeMinor: 6000,
    acceptingRequests: true,
    enabledByOrganization: true,
    pausedUntil: null,
    capacityLimit: null,
    openCount: 0,
    verifiedAt: new Date("2026-09-01"),
    regulator: "SRA",
    registrationNumber: "123",
    qualifiedJurisdictions: ["England and Wales"],
    practiceAreas: [area("Employment", "EMPLOYMENT")],
    user: { id, name: id, avatar: null, organizationMemberships: [] as unknown[] },
    ...overrides,
  };
}

const firm = (name: string, city: string | null, isPersonal = false) => [{ organization: { name, city, isPersonal } }];

function query(input: Record<string, unknown> = {}): ListClientLawyersQuery {
  const { error, value } = listClientLawyersSchema.validate(input, { convert: true });
  if (error) throw error;
  return value as ListClientLawyersQuery;
}

describe("ClientLawyerSvc.list", () => {
  let restore: () => void;
  let rows: ReturnType<typeof lawyer>[];
  let ratings: Map<string, { average: number; count: number }>;

  beforeEach(() => {
    restore = stash(LawyerProfileRepo, ["findForMarketplace", "ratingsFor"]);
    rows = [];
    ratings = new Map();
    (LawyerProfileRepo as any).findForMarketplace = async () => rows;
    (LawyerProfileRepo as any).ratingsFor = async () => ratings;
  });
  afterEach(() => restore());

  const ids = async (input: Record<string, unknown> = {}) => (await ClientLawyerSvc.list(query(input))).data.map((l) => l.id);

  it("lists only lawyers taking requests", async () => {
    rows = [
      lawyer("open"),
      lawyer("not-accepting", { acceptingRequests: false }),
      lawyer("disabled", { enabledByOrganization: false }),
      lawyer("paused", { pausedUntil: new Date(Date.now() + 60_000) }),
      lawyer("full", { capacityLimit: 1, openCount: 1 }),
    ];
    expect(await ids()).to.deep.equal(["open"]);
  });

  it("filters by case area through the lawyer's active, mapped practice areas", async () => {
    rows = [
      lawyer("employment"),
      lawyer("family", { practiceAreas: [area("Family", "FAMILY")] }),
      lawyer("inactive", { practiceAreas: [area("Employment", "EMPLOYMENT", false)] }),
    ];
    expect(await ids({ area: "EMPLOYMENT" })).to.deep.equal(["employment"]);
  });

  it("filters by jurisdiction", async () => {
    rows = [lawyer("ew"), lawyer("scot", { qualifiedJurisdictions: ["Scotland"] })];
    expect(await ids({ jurisdiction: "Scotland" })).to.deep.equal(["scot"]);
  });

  it("keeps a free first consultation under any limit and drops one not offered", async () => {
    rows = [lawyer("cheap", { firstConsultationFeeMinor: 5000 }), lawyer("dear", { firstConsultationFeeMinor: 9000 }), lawyer("free", { firstConsultationFeeMinor: 0 }), lawyer("none", { firstConsultationFeeMinor: null })];
    expect(await ids({ maxConsultationMinor: 6000, sort: "price" })).to.deep.equal(["free", "cheap"]);
  });

  it("filters by language, with Other for anything but English and Welsh", async () => {
    rows = [lawyer("en"), lawyer("cy", { languages: ["English", "Welsh"] }), lawyer("ta", { languages: ["English", "Tamil"] })];
    expect(await ids({ languages: "Welsh" })).to.deep.equal(["cy"]);
    expect(await ids({ languages: ["Other"] })).to.deep.equal(["ta"]);
    expect(await ids({ languages: ["welsh", "Other"] })).to.have.members(["cy", "ta"]);
  });

  it("searches name, firm and town, ignoring case", async () => {
    rows = [
      lawyer("Priya Natarajan", { user: { id: "p", name: "Priya Natarajan", avatar: null, organizationMemberships: firm("Northbridge", "Manchester") } }),
      lawyer("Daniel Okafor", { user: { id: "d", name: "Daniel Okafor", avatar: null, organizationMemberships: firm("Okafor & Co", "Leeds") } }),
    ];
    expect(await ids({ q: "priya" })).to.deep.equal(["Priya Natarajan"]);
    expect(await ids({ q: "okafor &" })).to.deep.equal(["Daniel Okafor"]);
    expect(await ids({ q: "manchester" })).to.deep.equal(["Priya Natarajan"]);
  });

  it("shows no firm or town for a solo lawyer or a personal workspace", async () => {
    rows = [lawyer("solo"), lawyer("personal", { user: { id: "personal", name: "personal", avatar: null, organizationMemberships: firm("Mine", "York", true) } })];
    const { data } = await ClientLawyerSvc.list(query());
    expect(data.map((l) => [l.firmName, l.town])).to.deep.equal([
      [null, null],
      [null, null],
    ]);
  });

  it("sorts a match by the case's area first, then by rating", async () => {
    rows = [lawyer("family-top", { practiceAreas: [area("Family", "FAMILY")] }), lawyer("employment-low"), lawyer("employment-high")];
    ratings = new Map([
      ["family-top", { average: 5, count: 9 }],
      ["employment-low", { average: 4.1, count: 3 }],
      ["employment-high", { average: 4.8, count: 2 }],
    ]);
    expect(await ids({ caseArea: "EMPLOYMENT" })).to.deep.equal(["employment-high", "employment-low", "family-top"]);
    expect(await ids({ sort: "rating" })).to.deep.equal(["family-top", "employment-high", "employment-low"]);
  });

  it("puts lawyers offering no first consultation last when sorting by price", async () => {
    rows = [lawyer("none", { firstConsultationFeeMinor: null }), lawyer("ninety", { firstConsultationFeeMinor: 9000 }), lawyer("free", { firstConsultationFeeMinor: 0 })];
    expect(await ids({ sort: "price" })).to.deep.equal(["free", "ninety", "none"]);
  });

  it("pages the list and counts every lawyer the filters let through", async () => {
    rows = ["a", "b", "c", "d", "e"].map((id) => lawyer(id));
    const page = await ClientLawyerSvc.list(query({ page: 2, limit: 2 }));
    expect(page.total).to.equal(5);
    expect(page.data.map((l) => l.id)).to.deep.equal(["c", "d"]);
  });

  it("returns the public profile with the fee in pence and a one-decimal rating", async () => {
    rows = [lawyer("x", { firstConsultationFeeMinor: 0, user: { id: "x", name: "X", avatar: null, organizationMemberships: firm("Firm", "Leeds") } })];
    ratings = new Map([["x", { average: 14 / 3, count: 3 }]]);
    const [l] = (await ClientLawyerSvc.list(query())).data;
    expect(l).to.include({ id: "x", name: "X", firmName: "Firm", town: "Leeds", regulator: "SRA", rating: 4.7, reviewCount: 3 });
    expect(l.firstConsultationFee).to.deep.equal({ amountMinor: 0, currency: "GBP" });
    expect(l.practiceAreas).to.deep.equal(["Employment"]);
    expect(l.caseAreas).to.deep.equal(["EMPLOYMENT"]);
  });
});

describe("listClientLawyersSchema", () => {
  it("refuses a jurisdiction outside the UK and an unknown sort", () => {
    expect(listClientLawyersSchema.validate({ jurisdiction: "France" }).error).to.exist;
    expect(listClientLawyersSchema.validate({ sort: "reply" }).error).to.exist;
  });
});

describe("ClientLawyerSvc.get", () => {
  let restore: (() => void)[];
  let rows: ReturnType<typeof lawyer>[];
  let feedback: { rating: number; comment: string | null; createdAt: Date; caseAreas: string[] }[];

  beforeEach(() => {
    restore = [stash(LawyerProfileRepo, ["findForMarketplace", "feedbackFor"]), stash(CaseAreaSvc, ["labeller"])];
    rows = [lawyer("x")];
    feedback = [];
    (LawyerProfileRepo as any).findForMarketplace = async (id?: string) => rows.filter((r) => r.userId === id);
    (LawyerProfileRepo as any).feedbackFor = async () => feedback;
    (CaseAreaSvc as any).labeller = async () => (codes: string[]) => codes.map((code) => ({ code, name: code === "EMPLOYMENT" ? "Employment" : code }));
  });
  afterEach(() => restore.forEach((r) => r()));

  it("answers 404 LAWYER_NOT_FOUND for anyone not listed", async () => {
    try {
      await ClientLawyerSvc.get("nobody");
      expect.fail("should have thrown");
    } catch (err: any) {
      expect({ status: err.statusCode, code: err.code }).to.deep.equal({ status: 404, code: "LAWYER_NOT_FOUND" });
    }
  });

  it("still shows a lawyer who isn't taking requests, as not available", async () => {
    rows = [lawyer("x", { acceptingRequests: false })];
    expect(await ClientLawyerSvc.get("x")).to.deep.include({ id: "x", available: false });
  });

  it("spreads the ratings by stars and shows the latest comments, without empty ones", async () => {
    const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}`);
    feedback = [
      { rating: 5, comment: " Clear about cost. ", createdAt: at(20), caseAreas: ["EMPLOYMENT"] },
      { rating: 4, comment: null, createdAt: at(10), caseAreas: ["EMPLOYMENT"] },
      { rating: 5, comment: "  ", createdAt: at(5), caseAreas: [] },
      { rating: 2, comment: "Slow replies.", createdAt: at(1), caseAreas: ["FAMILY"] },
    ];
    const profile = await ClientLawyerSvc.get("x");
    expect(profile).to.deep.include({ rating: 4, reviewCount: 4, available: true });
    expect(profile.ratingBreakdown).to.deep.equal([2, 1, 0, 1, 0]);
    expect(profile.reviews).to.deep.equal([
      { rating: 5, comment: "Clear about cost.", caseAreas: ["Employment"], createdAt: at(20) },
      { rating: 2, comment: "Slow replies.", caseAreas: ["FAMILY"], createdAt: at(1) },
    ]);
  });

  it("has no rating with no reviews", async () => {
    expect(await ClientLawyerSvc.get("x")).to.deep.include({ rating: null, reviewCount: 0 });
  });
});
