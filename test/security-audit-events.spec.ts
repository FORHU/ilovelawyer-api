/** Where the security audit log gets written from (docs/adr/0006-security-audit-log.md): sign-in
 * success and failure, logout, member role changes, file links, case-item deletions, and the
 * per-request context every row reads. No live Postgres/S3: repos and helpers are monkeypatched on
 * their CommonJS module objects, and SecurityAuditSvc.record is replaced to capture rows.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import AuthSvc from "../src/services/auth.service";
import OrganizationSvc from "../src/services/organization.service";
import SecurityAuditSvc from "../src/services/security-audit.service";
import FilesSvc from "../src/services/files.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import * as s3 from "../src/utils/s3";
import { getProxyFileUrl, getStableProxyFileUrl } from "../src/utils/s3";
import asyncHandler from "../src/utils/async-handler";
import recordCaseItemDeletions from "../src/middleware/record-case-item-deletions.middleware";
import { getRequestContext, requestContextMiddleware, runWithRequestContext, RequestContext } from "../src/lib/request-context";
import HttpError from "../src/utils/http-error";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

function contextFor(userId: string | null, organizationId: string | null = null): RequestContext {
  return {
    requestId: "req-1",
    ip: "203.0.113.7",
    userAgent: "test",
    userId: () => userId,
    organizationId: () => organizationId,
    tenantCode: () => null,
  };
}

// Wrapped so these hooks stay scoped to this file rather than becoming root hooks for the suite.
describe("Security audit events", () => {
  let records: any[];
  let restoreRecord: () => void;

  beforeEach(() => {
    records = [];
    restoreRecord = stash(SecurityAuditSvc, ["record"]);
    (SecurityAuditSvc as any).record = async (data: unknown) => void records.push(data);
  });

  afterEach(() => restoreRecord());

  describe("Security audit: sign-in", () => {
    let restore: (() => void)[];
    let user: any;

    beforeEach(async () => {
      user = {
        id: "user-1",
        email: "lawyer@firm.test",
        name: "Lawyer",
        role: "USER",
        password: await bcrypt.hash("Correct-horse-1", 4),
        isEmailVerified: true,
        mustChangePassword: false,
        googleId: null,
        provider: null,
        deletionRequestedAt: null,
      };
      restore = [stash(AuthRepo, ["findByEmail", "findById", "createSession", "updateLastLogin", "findByRefreshToken", "deleteByRefreshToken"])];
      (AuthRepo as any).findByEmail = async (email: string) => (email === user.email ? user : null);
      (AuthRepo as any).findById = async () => ({ id: user.id, email: user.email });
      (AuthRepo as any).createSession = async () => ({});
      (AuthRepo as any).updateLastLogin = async () => ({});
    });

    afterEach(() => restore.forEach((r) => r()));

    it("records a successful password login with the signed-in user", async () => {
      await AuthSvc.login("lawyer@firm.test", "Correct-horse-1");
      expect(records).to.deep.equal([{ action: "auth.login", actorId: "user-1", payload: { method: "password" } }]);
    });

    it("records a wrong password as a FAILURE naming the email tried, and still refuses with 401", async () => {
      let thrown: unknown;
      try {
        await AuthSvc.login("lawyer@firm.test", "wrong");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as HttpError).statusCode).to.equal(401);
      expect(records).to.deep.equal([
        {
          action: "auth.login",
          outcome: "FAILURE",
          actorId: null,
          attemptedEmail: "lawyer@firm.test",
          payload: { method: "password", reason: "Invalid email or password", status: 401 },
        },
      ]);
    });

    it("records an unknown email the same way", async () => {
      try {
        await AuthSvc.login("stranger@x.test", "whatever");
      } catch {
        /* expected */
      }
      expect(records[0]).to.include({ action: "auth.login", outcome: "FAILURE", attemptedEmail: "stranger@x.test" });
    });

    it("records logout against the session's user, and nothing for an unknown token", async () => {
      (AuthRepo as any).findByRefreshToken = async (token: string) => (token === "rt-1" ? { userId: "user-1" } : null);
      (AuthRepo as any).deleteByRefreshToken = async () => ({ count: 1 });

      await AuthSvc.logout("rt-1");
      await AuthSvc.logout("rt-unknown");

      expect(records).to.deep.equal([{ action: "auth.logout", actorId: "user-1" }]);
    });
  });

  describe("Security audit: member role change", () => {
    let restore: (() => void)[];

    beforeEach(() => {
      restore = [stash(OrganizationMemberRepo, ["find", "updateRole", "countByRole"])];
      (OrganizationMemberRepo as any).find = async () => ({ userId: "user-2", role: "MEMBER" });
      (OrganizationMemberRepo as any).updateRole = async () => ({ userId: "user-2", role: "ADMIN" });
      (OrganizationMemberRepo as any).countByRole = async () => 2;
    });

    afterEach(() => restore.forEach((r) => r()));

    it("records who changed whose role, from what to what", async () => {
      await OrganizationSvc.changeMemberRole("org-1", "OWNER", "user-2", "ADMIN");
      expect(records).to.deep.equal([
        {
          action: "org.member_role_changed",
          organizationId: "org-1",
          targetType: "user",
          targetId: "user-2",
          payload: { from: "MEMBER", to: "ADMIN" },
        },
      ]);
    });
  });

  describe("Security audit: file links", () => {
    const originals = { getPresignedGetUrl: s3.getPresignedGetUrl };

    beforeEach(() => {
      (s3 as any).getPresignedGetUrl = async (key: string) => `https://s3.example/${key}`;
    });

    afterEach(() => {
      (s3 as any).getPresignedGetUrl = originals.getPresignedGetUrl;
    });

    const tokenOf = (url: string) => url.replace(/^\/files\//, "");

    it("records file.accessed once per link, naming who it was issued to", async () => {
      const url = runWithRequestContext(contextFor("user-1", "org-1"), () =>
        getProxyFileUrl(`docs/${Date.now()}-a.pdf`, { audit: { kind: "document", id: "doc-1", caseId: "case-1" } }),
      );

      // An <audio>/<iframe> fetches the same link several times (Range requests).
      await FilesSvc.resolve(tokenOf(url));
      await FilesSvc.resolve(tokenOf(url));
      await FilesSvc.resolve(tokenOf(url));

      expect(records).to.deep.equal([
        {
          action: "file.accessed",
          actorId: "user-1",
          organizationId: "org-1",
          targetType: "document",
          targetId: "doc-1",
          caseId: "case-1",
          payload: { kind: "document", disposition: "attachment", via: "file_link" },
        },
      ]);
    });

    it("doesn't record avatars or other links minted without an audit target", async () => {
      await FilesSvc.resolve(tokenOf(getStableProxyFileUrl("avatars/a.png")));
      await FilesSvc.resolve(tokenOf(getProxyFileUrl(`misc/${Date.now()}.png`)));
      expect(records).to.have.length(0);
    });
  });

  describe("Security audit: request context", () => {
    function app() {
      const a = express();
      a.use(requestContextMiddleware);
      // Stands in for multer, which calls next() from a stream event outside the request's context.
      a.use((_req, _res, next) => runWithRequestContext(contextFor("someone-else"), () => next()));
      a.get(
        "/ctx",
        asyncHandler(async (_req, res) => {
          const ctx = getRequestContext();
          res.json({ requestId: ctx?.requestId, userId: ctx?.userId(), userAgent: ctx?.userAgent });
        }),
      );
      return a;
    }

    it("echoes a sane incoming X-Request-Id, and asyncHandler re-enters the request's own context", async () => {
      const res = await request(app()).get("/ctx").set("X-Request-Id", "lb-123").set("User-Agent", "Firm Browser");
      expect(res.headers["x-request-id"]).to.equal("lb-123");
      expect(res.body).to.deep.equal({ requestId: "lb-123", userId: null, userAgent: "Firm Browser" });
    });

    it("replaces a malformed X-Request-Id with its own", async () => {
      const res = await request(app()).get("/ctx").set("X-Request-Id", "<script>alert(1)</script> and spaces");
      expect(res.headers["x-request-id"]).to.match(/^[0-9a-f-]{36}$/);
    });
  });

  describe("Security audit: case item deletions", () => {
    function app(status: number) {
      const a = express();
      a.use(requestContextMiddleware);
      const router = express.Router();
      router.use(recordCaseItemDeletions);
      router.delete("/:caseId/findings/:id", (_req, res) => void res.status(status).end());
      router.delete("/:caseId/theories/:id/claims/:itemId", (_req, res) => void res.status(status).end());
      router.delete("/:id", (_req, res) => void res.status(status).end());
      a.use("/my-cases", router);
      return a;
    }

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("records a successful delete inside a case with the route template, not the URL", async () => {
      await request(app(204)).delete("/my-cases/case-1/findings/f-9");
      await request(app(204)).delete("/my-cases/case-1/theories/t-1/claims/c-2");
      await settle();
      expect(records).to.deep.equal([
        { action: "case.item_deleted", targetType: "case_item", targetId: "f-9", caseId: "case-1", payload: { route: "/my-cases/:caseId/findings/:id" } },
        {
          action: "case.item_deleted",
          targetType: "case_item",
          targetId: "c-2",
          caseId: "case-1",
          payload: { route: "/my-cases/:caseId/theories/:id/claims/:itemId" },
        },
      ]);
    });

    it("records nothing for a refused delete, or for deleting the case itself (CaseSvc records that)", async () => {
      await request(app(404)).delete("/my-cases/case-1/findings/f-9");
      await request(app(204)).delete("/my-cases/case-1");
      await settle();
      expect(records).to.have.length(0);
    });
  });
});
