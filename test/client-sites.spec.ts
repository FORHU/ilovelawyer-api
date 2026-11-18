/** The client app has one host per site (uk-client / ph-client / kr-client): the host a client
 * request comes from picks the site, a new client account is opened there, an account signs in
 * only on its own site (409 WRONG_SITE), and emailed links open the account's own site. Client
 * hosts are their own map, so a lawyer's links never point at the client app.
 *
 * No live Postgres: repositories are monkeypatched, as in test/client-app-role.spec.ts. */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";
import ClientCaseSvc from "../src/services/client-case.service";
import { requireClientAi, requireClientRequests } from "../src/middleware/require-client-site-feature.middleware";
import { CLIENT_CURRENCIES } from "../src/constants/client-pricing.constants";
import { runWithRequestContext } from "../src/lib/request-context";
import type { ClientApp } from "../src/utils/client-app";
import { REFRESH_TOKEN_SECRET, USER_APP_URL, CLIENT_URL } from "../src/config";
import {
  clientOriginForSite,
  emailLinkOriginForAccount,
  originForTenantCode,
  resolveClientTenantFromHost,
  resolveTenantCodeFromHost,
  resolveTenantCodeFromRequest,
} from "../src/utils/tenant-host";

const UK_CLIENT = "http://uk-client.ilovelawyer.localhost:3004";
const PH_CLIENT = "http://ph-client.ilovelawyer.localhost:3004";
const KR_CLIENT = "http://kr-client.ilovelawyer.localhost:3004";
const PLAIN_CLIENT = "http://localhost:3004";
const KR_LAWYER = "http://kr.ilovelawyer.local:3002";
const UK_LAWYER = "http://uk.ilovelawyer.local:3002";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

function inApp<T>(clientApp: ClientApp, fn: () => Promise<T>): Promise<T> {
  const context = { requestId: "req-1", ip: null, userAgent: null, userId: () => null, organizationId: () => null, tenantCode: () => null, clientApp };
  return runWithRequestContext(context, fn);
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.status ?? err.statusCode, code: err.code, details: err.details };
  }
}

const requestFrom = (origin: string | undefined, app?: "user") =>
  ({ headers: { ...(origin ? { origin } : {}), ...(app ? { "x-client-app": app } : {}) } }) as unknown as Request;

describe("Client app sites", () => {
  let saved: { user: string[]; client: string[] };

  before(() => {
    saved = { user: [...USER_APP_URL], client: [...CLIENT_URL] };
    USER_APP_URL.splice(0, USER_APP_URL.length, PLAIN_CLIENT, UK_CLIENT, PH_CLIENT, KR_CLIENT);
    CLIENT_URL.splice(0, CLIENT_URL.length, UK_LAWYER, KR_LAWYER, PLAIN_CLIENT, UK_CLIENT, PH_CLIENT, KR_CLIENT);
  });

  after(() => {
    USER_APP_URL.splice(0, USER_APP_URL.length, ...saved.user);
    CLIENT_URL.splice(0, CLIENT_URL.length, ...saved.client);
  });

  describe("hosts", () => {
    it("maps each client host to its site, and keeps lawyer and client hosts apart", () => {
      expect(resolveClientTenantFromHost("kr-client.ilovelawyer.localhost:3004")).to.equal("KR");
      expect(resolveClientTenantFromHost("ph-client-dev.ilovelawyer.com")).to.equal("PH");
      expect(resolveClientTenantFromHost("uk-client.ilovelawyer.com")).to.equal("UK");
      expect(resolveClientTenantFromHost("kr.ilovelawyer.local")).to.equal(null);
      expect(resolveTenantCodeFromHost("kr-client.ilovelawyer.localhost")).to.equal(null);
    });

    it("reads a client request against the client hosts, and any other host as the UK site", () => {
      expect(resolveTenantCodeFromRequest(requestFrom(KR_CLIENT, "user"))).to.equal("KR");
      expect(resolveTenantCodeFromRequest(requestFrom(PH_CLIENT, "user"))).to.equal("PH");
      expect(resolveTenantCodeFromRequest(requestFrom(PLAIN_CLIENT, "user"))).to.equal("UK");
      expect(resolveTenantCodeFromRequest(requestFrom(KR_LAWYER, "user"))).to.equal("UK");
      expect(resolveTenantCodeFromRequest(requestFrom(undefined, "user"))).to.equal(null);
    });

    it("never reads a client host as a lawyer's site", () => {
      expect(resolveTenantCodeFromRequest(requestFrom(KR_LAWYER))).to.equal("KR");
      expect(resolveTenantCodeFromRequest(requestFrom(KR_CLIENT))).to.equal(null);
    });

    it("never points a lawyer's emailed link at the client app", () => {
      expect(originForTenantCode("KR")).to.equal(KR_LAWYER);
      expect(emailLinkOriginForAccount({ role: "LAWYER", tenant: { code: "KR" } }, KR_CLIENT)).to.equal(KR_LAWYER);
    });
  });

  describe("emailed links for a client", () => {
    it("open the client's own site", () => {
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "KR" } }, null)).to.equal(KR_CLIENT);
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "PH" } }, KR_CLIENT)).to.equal(PH_CLIENT);
    });

    it("keep the origin the client asked from when it's their site's", () => {
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "KR" } }, KR_CLIENT)).to.equal(KR_CLIENT);
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, UK_CLIENT)).to.equal(UK_CLIENT);
    });

    it("send a UK client to the first client app, as before", () => {
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, null)).to.equal(PLAIN_CLIENT);
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, KR_CLIENT)).to.equal(PLAIN_CLIENT);
    });

    it("finds each site's client origin", () => {
      expect(clientOriginForSite("KR")).to.equal(KR_CLIENT);
      expect(clientOriginForSite("UK")).to.equal(PLAIN_CLIENT);
    });
  });

  describe("what each site offers", () => {
    const run = (guard: typeof requireClientAi, tenantCode: string) => {
      const req = { workspace: { organizationId: "org-1", ownerId: null, userId: "u1", role: "OWNER", tenantCode } } as unknown as Request;
      let passed = false;
      try {
        guard(req, {} as any, () => {
          passed = true;
        });
        return passed ? "open" : "stuck";
      } catch (err: any) {
        return `${err.statusCode} ${err.code}`;
      }
    };

    it("runs the AI only on sites with their own intake persona (UK, KR)", () => {
      expect(run(requireClientAi, "UK")).to.equal("open");
      expect(run(requireClientAi, "KR")).to.equal("open");
      expect(run(requireClientAi, "PH")).to.equal("403 CLIENT_AI_NOT_OPEN");
    });

    it("offers lawyers on the UK and KR sites, not yet on PH", () => {
      expect(run(requireClientRequests, "UK")).to.equal("open");
      expect(run(requireClientRequests, "KR")).to.equal("open");
      expect(run(requireClientRequests, "PH")).to.equal("403 CLIENT_REQUESTS_NOT_OPEN");
    });

    it("never lets the UK intake persona answer a PH client, even past the route", async () => {
      const ws = { id: "org-ph", role: "OWNER" as const, tenantCode: "PH" as const };
      expect(await errorOf(ClientCaseSvc.sendMessage(ws, "u1", "case-1", "hello"))).to.deep.include({ status: 403, code: "CLIENT_AI_NOT_OPEN" });
      expect(await errorOf(ClientCaseSvc.sendVoiceMessage(ws, "u1", "case-1", "voice/key"))).to.deep.include({ status: 403, code: "CLIENT_AI_NOT_OPEN" });
    });

    it("lets an admin price a KR site in whole won", () => {
      expect(CLIENT_CURRENCIES.KRW).to.deep.equal({ exponent: 0, minMinor: 1_000, maxMinor: 1_500_000 });
    });
  });

  describe("sign-in on another site", () => {
    const PASSWORD = "Correct-horse-1";
    let restore: () => void;
    let site: string | null;
    let role: string;
    let sessions: string[];

    beforeEach(async () => {
      site = "UK";
      role = "USER";
      sessions = [];
      const password = await bcrypt.hash(PASSWORD, 4);
      restore = stash(AuthRepo, ["findByEmail", "findById", "createSession", "updateLastLogin", "findSiteCode", "findByRefreshToken", "deleteByRefreshToken", "findTrialState"]);
      const user = () => ({ id: "client-1", email: "a@b.com", name: "A", password, provider: null, role, googleId: null, isEmailVerified: true, mustChangePassword: false, approvalStatus: "ACTIVE", deletionRequestedAt: null });
      (AuthRepo as any).findByEmail = async () => user();
      (AuthRepo as any).findById = async () => user();
      (AuthRepo as any).createSession = async (id: string) => void sessions.push(id);
      (AuthRepo as any).updateLastLogin = async () => {};
      (AuthRepo as any).findSiteCode = async () => site;
      (AuthRepo as any).findByRefreshToken = async (token: string) => ({ token, userId: "client-1" });
      (AuthRepo as any).deleteByRefreshToken = async () => {};
      (AuthRepo as any).findTrialState = async () => null;
    });

    afterEach(() => restore());

    const login = (requestSite: "UK" | "PH" | "KR" | null) => inApp("user", () => AuthSvc.login("a@b.com", PASSWORD, false, requestSite));

    it("refuses a UK client on the KR site with WRONG_SITE and where to go", async () => {
      const err = await errorOf(login("KR"));
      expect(err).to.deep.include({ status: 409, code: "WRONG_SITE" });
      expect(err?.details).to.deep.equal({ site: "UK", siteUrl: PLAIN_CLIENT });
      expect(sessions).to.be.empty;
    });

    it("lets a client in on its own site, and when the request names no site", async () => {
      site = "KR";
      await login("KR");
      await login(null);
      expect(sessions).to.deep.equal(["client-1", "client-1"]);
    });

    it("sends a KR client on the UK site to the KR site", async () => {
      site = "KR";
      expect((await errorOf(login("UK")))?.details).to.deep.equal({ site: "KR", siteUrl: KR_CLIENT });
    });

    it("won't resume a session on another site's host", async () => {
      const token = jwt.sign({ userId: "client-1" }, REFRESH_TOKEN_SECRET);
      expect((await errorOf(inApp("user", () => AuthSvc.refresh(token, "KR"))))?.status).to.equal(401);
    });

    it("keeps the lawyer app's message for a lawyer on another site", async () => {
      role = "LAWYER";
      site = "PH";
      const err = await errorOf(inApp("lawyer", () => AuthSvc.login("a@b.com", PASSWORD, false, "UK")));
      expect(err).to.deep.include({ status: 409, code: undefined });
    });
  });
});
