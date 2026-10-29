/** planGate — verify before plan enforced for the whole API: a held lawyer reaches only what the
 * verification and plan steps need. PlanGateSvc is monkeypatched; no DB. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import PlanGateSvc from "../src/services/plan-gate.service";
import { planGate } from "../src/middleware/plan-gate.middleware";
import HttpError from "../src/utils/http-error";
import { ACCESS_TOKEN_SECRET } from "../src/config";

const token = jwt.sign({ userId: "held-1" }, ACCESS_TOKEN_SECRET);

async function run(method: string, path: string, authorization: string | null = `Bearer ${token}`) {
  let passed: unknown = "not called";
  const req: any = { method, baseUrl: "/api", path, headers: authorization ? { authorization } : {} };
  await planGate(req, {} as any, (err?: unknown) => {
    passed = err ?? null;
  });
  return passed as { code?: string } | null;
}

describe("planGate middleware", () => {
  const original = PlanGateSvc.assertOpenForRequest;
  let checked: string[];

  beforeEach(() => {
    checked = [];
    (PlanGateSvc as any).assertOpenForRequest = async (userId: string) => {
      checked.push(userId);
      throw new HttpError("held", 403, "VERIFICATION_REQUIRED");
    };
  });
  afterEach(() => {
    (PlanGateSvc as any).assertOpenForRequest = original;
  });

  it("refuses a held lawyer everywhere else, reads included", async () => {
    for (const [method, path] of [["GET", "/my-cases"], ["POST", "/chat/c1/messages"], ["GET", "/documents/d1"], ["GET", "/client-requests"]]) {
      expect(await run(method, path)).to.include({ code: "VERIFICATION_REQUIRED" });
    }
    expect(checked).to.have.length(4);
  });

  it("keeps open what the verification and plan steps need", async () => {
    for (const path of [
      "/auth/logout",
      "/users/me",
      "/users/me/plan-gate/start",
      "/users/me/client-request-profile",
      "/organizations",
      "/payment-plans/checkout",
      "/billing/top-up-packs",
      "/practice-areas",
      "/consents",
    ]) {
      expect(await run("POST", path)).to.equal(null);
    }
    expect(checked).to.deep.equal([]);
  });

  it("leaves a request with no or a bad token to the router's own checks", async () => {
    expect(await run("GET", "/my-cases", null)).to.equal(null);
    expect(await run("GET", "/my-cases", "Bearer not-a-token")).to.equal(null);
    expect(checked).to.deep.equal([]);
  });
});
