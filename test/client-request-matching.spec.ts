/** ClientRequestMatchingSvc — the request matching engine (#509). A lawyer matches a request when
 * they're verified, accepting requests, enabled by their organization, not paused, under capacity,
 * and qualified for the case's practice area and UK jurisdiction.
 *
 * No live Postgres: repos are monkeypatched on their CommonJS module objects, same idiom as
 * test/lawyer-verification.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestMatchingSvc, { caseAreasOf, type MatchablePracticeArea } from "../src/services/client-request-matching.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

type Lawyer = {
  userId: string;
  acceptingRequests: boolean;
  enabledByOrganization: boolean;
  pausedUntil: Date | null;
  capacityLimit: number | null;
  openCount: number;
  practiceAreas: MatchablePracticeArea[];
  qualifiedJurisdictions: string[];
};

/** A practice area the lawyer holds, mapped to a client case area (or not). */
const mapped = (caseArea: string | null, isActive = true): MatchablePracticeArea => ({ caseArea, isActive });

const ELIGIBLE: Lawyer = {
  userId: "lawyer-1",
  acceptingRequests: true,
  enabledByOrganization: true,
  pausedUntil: null,
  capacityLimit: null,
  openCount: 0,
  practiceAreas: [mapped("EMPLOYMENT")],
  qualifiedJurisdictions: ["England and Wales"],
};

const CRITERIA = { caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" };

describe("ClientRequestMatchingSvc.matches", () => {
  it("matches a verified, accepting lawyer qualified for the case", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, CRITERIA)).to.equal(true);
  });

  it("refuses a lawyer not accepting requests", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, acceptingRequests: false }, CRITERIA)).to.equal(false);
  });

  it("refuses a lawyer their organization has disabled", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, enabledByOrganization: false }, CRITERIA)).to.equal(false);
  });

  it("refuses a lawyer paused until a future date", () => {
    const paused = { ...ELIGIBLE, pausedUntil: new Date(Date.now() + 60_000) };
    expect(ClientRequestMatchingSvc.matches(paused, CRITERIA, new Date())).to.equal(false);
  });

  it("matches a lawyer whose pause has already lapsed", () => {
    const lapsed = { ...ELIGIBLE, pausedUntil: new Date(Date.now() - 60_000) };
    expect(ClientRequestMatchingSvc.matches(lapsed, CRITERIA, new Date())).to.equal(true);
  });

  it("refuses a lawyer without the case's practice area", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, practiceAreas: [mapped("FAMILY")] }, CRITERIA)).to.equal(false);
  });

  it("matches a case with several areas through any one of them", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { ...CRITERIA, caseAreas: ["CONSUMER", "EMPLOYMENT"] })).to.equal(true);
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { ...CRITERIA, caseAreas: ["CONSUMER", "FAMILY"] })).to.equal(false);
  });

  it("matches through any one of the lawyer's areas mapped to the case's area", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, practiceAreas: [mapped(null), mapped("FAMILY"), mapped("EMPLOYMENT")] }, CRITERIA)).to.equal(true);
  });

  it("ignores an area an admin switched off, and one that isn't mapped to a case area", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, practiceAreas: [mapped("EMPLOYMENT", false)] }, CRITERIA)).to.equal(false);
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, practiceAreas: [mapped(null)] }, CRITERIA)).to.equal(false);
  });

  it("refuses a lawyer not qualified in the case's jurisdiction", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, qualifiedJurisdictions: ["Scotland"] }, CRITERIA)).to.equal(false);
  });

  it("refuses when the case has no case area", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { caseAreas: [], ukJurisdiction: "England and Wales" })).to.equal(false);
  });

  it("refuses when the case has no UK jurisdiction set", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { caseAreas: ["EMPLOYMENT"], ukJurisdiction: null })).to.equal(false);
  });

  it("matches a lawyer under their capacity limit", () => {
    const underCapacity = { ...ELIGIBLE, capacityLimit: 3, openCount: 2 };
    expect(ClientRequestMatchingSvc.matches(underCapacity, CRITERIA)).to.equal(true);
  });

  it("refuses a lawyer at their capacity limit", () => {
    const atCapacity = { ...ELIGIBLE, capacityLimit: 3, openCount: 3 };
    expect(ClientRequestMatchingSvc.matches(atCapacity, CRITERIA)).to.equal(false);
  });

  it("refuses a lawyer over their capacity limit", () => {
    const overCapacity = { ...ELIGIBLE, capacityLimit: 3, openCount: 4 };
    expect(ClientRequestMatchingSvc.matches(overCapacity, CRITERIA)).to.equal(false);
  });

  it("matches a lawyer with any open count when capacityLimit is null (unlimited)", () => {
    const unlimited = { ...ELIGIBLE, capacityLimit: null, openCount: 999 };
    expect(ClientRequestMatchingSvc.matches(unlimited, CRITERIA)).to.equal(true);
  });
});

describe("caseAreasOf", () => {
  it("gives the case areas a lawyer's active, mapped areas cover, each once", () => {
    expect(caseAreasOf([mapped("PROPERTY"), mapped("PROPERTY"), mapped("FAMILY", false), mapped(null), mapped("OTHER")])).to.deep.equal(["PROPERTY", "OTHER"]);
  });
});

describe("ClientRequestMatchingSvc.route / reroute / eligibleLawyerIds", () => {
  let restore: (() => void)[];
  let routed: { id: string }[];
  let rerouted: { id: string; excludeLawyerId: string }[];
  let rerouteResult: boolean;
  let matchingRow: { excludedLawyerIds: string[]; case: { caseAreas: string[]; ukJurisdiction: string | null } } | null;
  let candidates: Lawyer[];
  let requestedExcludeIds: string[][];

  beforeEach(() => {
    routed = [];
    rerouted = [];
    rerouteResult = true;
    matchingRow = { excludedLawyerIds: [], case: { caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } };
    candidates = [ELIGIBLE];
    requestedExcludeIds = [];

    restore = [stash(ClientRequestRepo, ["route", "findForMatching", "reroute"]), stash(LawyerProfileRepo, ["findVerified"])];

    (ClientRequestRepo as any).route = async (id: string) => {
      routed.push({ id });
      return { id, status: "ROUTED" };
    };
    (ClientRequestRepo as any).findForMatching = async () => matchingRow;
    (ClientRequestRepo as any).reroute = async (id: string, excludeLawyerId: string) => {
      rerouted.push({ id, excludeLawyerId });
      return rerouteResult;
    };
    (LawyerProfileRepo as any).findVerified = async (excludeIds: string[]) => {
      requestedExcludeIds.push(excludeIds);
      return candidates;
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  it("routes a freshly created request", async () => {
    const result = await ClientRequestMatchingSvc.route("req-1");
    expect(routed).to.deep.equal([{ id: "req-1" }]);
    expect(result.status).to.equal("ROUTED");
  });

  it("finds every verified candidate who matches the request's case, minus exclusions", async () => {
    matchingRow!.excludedLawyerIds = ["lawyer-9"];
    const ids = await ClientRequestMatchingSvc.eligibleLawyerIds("req-1");
    expect(requestedExcludeIds).to.deep.equal([["lawyer-9"]]);
    expect(ids).to.deep.equal(["lawyer-1"]);
  });

  it("drops a verified candidate who doesn't actually match the case", async () => {
    candidates = [{ ...ELIGIBLE, practiceAreas: [mapped("FAMILY")] }];
    expect(await ClientRequestMatchingSvc.eligibleLawyerIds("req-1")).to.deep.equal([]);
  });

  it("returns no eligible lawyers for an unknown request", async () => {
    matchingRow = null;
    expect(await ClientRequestMatchingSvc.eligibleLawyerIds("missing")).to.deep.equal([]);
  });

  it("reroutes a held request without the lawyer who passed or released", async () => {
    const result = await ClientRequestMatchingSvc.reroute("req-1", "lawyer-1");
    expect(rerouted).to.deep.equal([{ id: "req-1", excludeLawyerId: "lawyer-1" }]);
    expect(result).to.equal(true);
  });

  it("reports a failed reroute (the request wasn't held)", async () => {
    rerouteResult = false;
    expect(await ClientRequestMatchingSvc.reroute("req-1", "lawyer-1")).to.equal(false);
  });
});
