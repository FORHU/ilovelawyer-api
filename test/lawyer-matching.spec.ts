/** POST /lawyer-matching/by-criteria (#558-adjacent, intake's find-a-lawyer): criteria-based lawyer
 * matching for chat-wonder's find_lawyer tool and the client app's direct "browse lawyers" feature,
 * neither of which has a ClientRequest to match against. Guarded by apiKeyMiddleware
 * (CHAT_WONDER_API_KEY), same as case-document/generated-document/model-settings. No live Postgres:
 * ClientRequestMatchingSvc is monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import ClientRequestMatchingSvc, { type CriteriaMatchInput, type RankedLawyerMatch } from "../src/services/client-request-matching.service";
import { CHAT_WONDER_API_KEY } from "../src/config";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("POST /lawyer-matching/by-criteria", () => {
  let restore: () => void;
  let received: CriteriaMatchInput | null;
  let result: RankedLawyerMatch[];

  const post = (body: object, headers: Record<string, string> = { "x-api-key": CHAT_WONDER_API_KEY }) => request(app).post("/api/v1/lawyer-matching/by-criteria").set(headers).send(body);

  beforeEach(() => {
    restore = stash(ClientRequestMatchingSvc, ["matchByCriteria"]);
    received = null;
    result = [{ lawyerId: "lawyer-1", budgetFitScore: 0 }];
    (ClientRequestMatchingSvc as any).matchByCriteria = async (input: CriteriaMatchInput) => {
      received = input;
      return result;
    };
  });

  afterEach(() => restore());

  it("refuses a call with no or a wrong API key", async () => {
    expect((await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" }, {})).status).to.equal(401);
    expect((await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" }, { "x-api-key": "wrong" })).status).to.equal(401);
    expect(received).to.equal(null);
  });

  it("passes caseAreas, ukJurisdiction and the ranked matches through", async () => {
    const res = await post({ caseAreas: ["EMPLOYMENT", "CONSUMER"], ukJurisdiction: "England and Wales" });
    expect(res.status).to.equal(200);
    expect(received).to.deep.equal({ caseAreas: ["EMPLOYMENT", "CONSUMER"], ukJurisdiction: "England and Wales", budget: undefined });
    expect(res.body).to.deep.equal({ matches: result });
  });

  it("passes a budget range through, and null explicitly", async () => {
    await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales", budget: { minMinor: 50_000, maxMinor: 150_000, feePreference: "FIXED_FEE" } });
    expect(received!.budget).to.deep.equal({ minMinor: 50_000, maxMinor: 150_000, feePreference: "FIXED_FEE" });

    await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales", budget: null });
    expect(received!.budget).to.equal(null);
  });

  it("refuses caseAreas that isn't a string array", async () => {
    expect((await post({ caseAreas: "EMPLOYMENT", ukJurisdiction: "England and Wales" })).status).to.equal(400);
    expect((await post({ caseAreas: [1, 2], ukJurisdiction: "England and Wales" })).status).to.equal(400);
    expect(received).to.equal(null);
  });

  it("takes no UK jurisdiction as null (a non-UK case matches nothing, by design)", async () => {
    const res = await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: null });
    expect(res.status).to.equal(200);
    expect(received!.ukJurisdiction).to.equal(null);
  });

  it("takes an omitted ukJurisdiction key the same as an explicit null, not a 400", async () => {
    const res = await post({ caseAreas: ["EMPLOYMENT"] });
    expect(res.status).to.equal(200);
    expect(received!.ukJurisdiction).to.equal(null);
  });

  it("refuses a ukJurisdiction that's neither a string nor null", async () => {
    expect((await post({ caseAreas: ["EMPLOYMENT"], ukJurisdiction: 1 })).status).to.equal(400);
  });
});
