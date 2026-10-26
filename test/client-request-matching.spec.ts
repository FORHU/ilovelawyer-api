/** ClientRequestMatchingSvc — the request matching engine (#509). A lawyer matches a request when
 * they're verified, accepting requests, enabled by their organization, not paused, under capacity,
 * and qualified for the case's practice area and UK jurisdiction.
 *
 * No live Postgres: repos are monkeypatched on their CommonJS module objects, same idiom as
 * test/lawyer-verification.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestMatchingSvc, { type MembershipForMatching } from "../src/services/client-request-matching.service";
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
  practiceAreas: string[];
  qualifiedJurisdictions: string[];
  membership: MembershipForMatching | null;
};

const ELIGIBLE: Lawyer = {
  userId: "lawyer-1",
  acceptingRequests: true,
  enabledByOrganization: true,
  pausedUntil: null,
  capacityLimit: null,
  openCount: 0,
  practiceAreas: ["EMPLOYMENT"],
  qualifiedJurisdictions: ["England and Wales"],
  membership: null,
};

/** An accepted member of an active firm. */
const FIRM: MembershipForMatching = { status: "ACCEPTED", organization: { id: "org-1", isPersonal: false, status: "ACTIVE", packageSku: "PROFESSIONAL" } };
const CLOSING_FIRM: MembershipForMatching = { ...FIRM, organization: { ...FIRM.organization, status: "PENDING_DELETION" } };

const CRITERIA = { practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" };

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
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, practiceAreas: ["FAMILY"] }, CRITERIA)).to.equal(false);
  });

  it("refuses a lawyer not qualified in the case's jurisdiction", () => {
    expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, qualifiedJurisdictions: ["Scotland"] }, CRITERIA)).to.equal(false);
  });

  it("refuses when the case has no practice area set", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { practiceArea: null, ukJurisdiction: "England and Wales" })).to.equal(false);
  });

  it("refuses when the case has no UK jurisdiction set", () => {
    expect(ClientRequestMatchingSvc.matches(ELIGIBLE, { practiceArea: "EMPLOYMENT", ukJurisdiction: null })).to.equal(false);
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

  describe("with client requests for firms on", () => {
    beforeEach(() => (process.env.CLIENT_REQUESTS_FOR_FIRMS = "true"));
    afterEach(() => delete process.env.CLIENT_REQUESTS_FOR_FIRMS);

    it("matches a lawyer whose firm is active", () => {
      expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, membership: FIRM }, CRITERIA)).to.equal(true);
    });

    it("refuses a lawyer whose firm is being deleted", () => {
      expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, membership: CLOSING_FIRM }, CRITERIA)).to.equal(false);
    });
  });

  describe("with client requests for firms off (the default, solo practitioners only)", () => {
    it("refuses a lawyer in a firm", () => {
      expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, membership: FIRM }, CRITERIA)).to.equal(false);
    });

    it("still matches a solo lawyer", () => {
      expect(ClientRequestMatchingSvc.matches(ELIGIBLE, CRITERIA)).to.equal(true);
    });

    it("still matches a lawyer whose firm invite isn't accepted yet: they're solo", () => {
      expect(ClientRequestMatchingSvc.matches({ ...ELIGIBLE, membership: { ...FIRM, status: "PENDING" } }, CRITERIA)).to.equal(true);
    });
  });
});

/** iFindLawyer (#558): whether the lawyer works alone or for a firm, from their membership. */
describe("ClientRequestMatchingSvc.affiliationOf", () => {
  it("is SOLO with no membership", () => {
    expect(ClientRequestMatchingSvc.affiliationOf(null)).to.deep.equal({ kind: "SOLO" });
  });

  it("is SOLO while the firm invite is still pending", () => {
    expect(ClientRequestMatchingSvc.affiliationOf({ ...FIRM, status: "PENDING" })).to.deep.equal({ kind: "SOLO" });
  });

  it("is SOLO for a personal workspace", () => {
    expect(ClientRequestMatchingSvc.affiliationOf({ ...FIRM, organization: { ...FIRM.organization, isPersonal: true } })).to.deep.equal({ kind: "SOLO" });
  });

  it("is ORGANIZATION for an accepted firm membership, with its id, package and status", () => {
    expect(ClientRequestMatchingSvc.affiliationOf(FIRM)).to.deep.equal({ kind: "ORGANIZATION", organizationId: "org-1", packageSku: "PROFESSIONAL", organizationStatus: "ACTIVE" });
  });
});

describe("ClientRequestMatchingSvc.route / reroute / eligibleLawyerIds", () => {
  let restore: (() => void)[];
  let routed: { id: string }[];
  let rerouted: { id: string; excludeLawyerId: string }[];
  let rerouteResult: boolean;
  let matchingRow: { excludedLawyerIds: string[]; case: { practiceArea: string | null; ukJurisdiction: string | null } } | null;
  let candidates: Lawyer[];
  let requestedExcludeIds: string[][];

  beforeEach(() => {
    routed = [];
    rerouted = [];
    rerouteResult = true;
    matchingRow = { excludedLawyerIds: [], case: { practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" } };
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
    candidates = [{ ...ELIGIBLE, practiceAreas: ["FAMILY"] }];
    expect(await ClientRequestMatchingSvc.eligibleLawyerIds("req-1")).to.deep.equal([]);
  });

  it("leaves out a lawyer whose firm is being deleted", async () => {
    process.env.CLIENT_REQUESTS_FOR_FIRMS = "true";
    try {
      candidates = [ELIGIBLE, { ...ELIGIBLE, userId: "lawyer-2", membership: CLOSING_FIRM }, { ...ELIGIBLE, userId: "lawyer-3", membership: FIRM }];
      expect(await ClientRequestMatchingSvc.eligibleLawyerIds("req-1")).to.deep.equal(["lawyer-1", "lawyer-3"]);
    } finally {
      delete process.env.CLIENT_REQUESTS_FOR_FIRMS;
    }
  });

  it("leaves out every firm lawyer while client requests for firms are off", async () => {
    candidates = [ELIGIBLE, { ...ELIGIBLE, userId: "lawyer-3", membership: FIRM }];
    expect(await ClientRequestMatchingSvc.eligibleLawyerIds("req-1")).to.deep.equal(["lawyer-1"]);
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
