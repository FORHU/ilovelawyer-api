import { expect } from "chai";
import { afterEach, describe, it } from "mocha";
import EngagementAccessSvc from "../src/services/engagement-access.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import { SHARED_CASES_CHANGED } from "../src/services/case-share.service";
import * as socket from "../src/lib/socket";

// The read-only grant an engaged lawyer gets on the client's case (ilovelawyer-api#514, ADR 0016):
// the same CaseAccess VIEW row CaseShareSvc grants for a portfolio share, made by the system once
// the client's per-case fee is paid, and taken back once the engagement ends.

const stash = {
  grantCaseAccess: OrganizationRepo.grantCaseAccess,
  revokeCaseAccess: OrganizationRepo.revokeCaseAccess,
  record: SecurityAuditSvc.record,
  emitToUser: socket.emitToUser,
  removeUserFromCase: socket.removeUserFromCase,
};
const restore = () => {
  Object.assign(OrganizationRepo, { grantCaseAccess: stash.grantCaseAccess, revokeCaseAccess: stash.revokeCaseAccess });
  Object.assign(SecurityAuditSvc, { record: stash.record });
  Object.assign(socket, { emitToUser: stash.emitToUser, removeUserFromCase: stash.removeUserFromCase });
};

describe("EngagementAccessSvc", () => {
  afterEach(restore);

  describe("grant", () => {
    it("gives the lawyer a VIEW CaseAccess grant on the client's case", async () => {
      const calls: unknown[] = [];
      (OrganizationRepo as any).grantCaseAccess = async (caseId: string, userId: string, permission: string) => {
        calls.push(["grantCaseAccess", caseId, userId, permission]);
        return {};
      };
      (SecurityAuditSvc as any).record = async () => {};
      (socket as any).emitToUser = () => {};

      await EngagementAccessSvc.grant({ requestId: "r1", caseId: "c1", lawyerId: "bob", organizationId: "org1" });

      expect(calls).to.deep.equal([["grantCaseAccess", "c1", "bob", "VIEW"]]);
    });

    it("audits the grant as a system action, tied to the request and case", async () => {
      (OrganizationRepo as any).grantCaseAccess = async () => ({});
      const recorded: unknown[] = [];
      (SecurityAuditSvc as any).record = async (input: unknown) => recorded.push(input);
      (socket as any).emitToUser = () => {};

      await EngagementAccessSvc.grant({ requestId: "r1", caseId: "c1", lawyerId: "bob", organizationId: "org1" });

      expect(recorded).to.deep.equal([
        {
          action: "case.access_granted",
          actorId: null,
          organizationId: "org1",
          targetType: "user",
          targetId: "bob",
          caseId: "c1",
          payload: { permission: "VIEW", requestId: "r1", engagement: true },
        },
      ]);
    });

    it("tells the lawyer's open tabs the case is now shared with them", async () => {
      (OrganizationRepo as any).grantCaseAccess = async () => ({});
      (SecurityAuditSvc as any).record = async () => {};
      const emitted: unknown[] = [];
      (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);

      await EngagementAccessSvc.grant({ requestId: "r1", caseId: "c1", lawyerId: "bob", organizationId: "org1" });

      expect(emitted).to.deep.equal([["bob", SHARED_CASES_CHANGED, { caseId: "c1", shared: true }]]);
    });
  });

  describe("revoke", () => {
    it("removes the lawyer's CaseAccess grant", async () => {
      const calls: unknown[] = [];
      (OrganizationRepo as any).revokeCaseAccess = async (caseId: string, userId: string) => {
        calls.push(["revokeCaseAccess", caseId, userId]);
        return true;
      };
      (SecurityAuditSvc as any).record = async () => {};
      (socket as any).emitToUser = () => {};
      (socket as any).removeUserFromCase = () => {};

      const removed = await EngagementAccessSvc.revoke({ requestId: "r1", caseId: "c1", lawyerId: "bob" });

      expect(removed).to.equal(true);
      expect(calls).to.deep.equal([["revokeCaseAccess", "c1", "bob"]]);
    });

    it("does nothing further when there was no grant to remove", async () => {
      (OrganizationRepo as any).revokeCaseAccess = async () => false;
      const recorded: unknown[] = [];
      (SecurityAuditSvc as any).record = async (input: unknown) => recorded.push(input);
      const emitted: unknown[] = [];
      (socket as any).emitToUser = (...args: unknown[]) => emitted.push(args);
      (socket as any).removeUserFromCase = (...args: unknown[]) => emitted.push(args);

      const removed = await EngagementAccessSvc.revoke({ requestId: "r1", caseId: "c1", lawyerId: "bob" });

      expect(removed).to.equal(false);
      expect(recorded).to.deep.equal([]);
      expect(emitted).to.deep.equal([]);
    });

    it("drops the lawyer's sockets from the case room and tells their open tabs access ended", async () => {
      (OrganizationRepo as any).revokeCaseAccess = async () => true;
      (SecurityAuditSvc as any).record = async () => {};
      const removedFromCase: unknown[] = [];
      const emitted: unknown[] = [];
      (socket as any).removeUserFromCase = (userId: string, caseId: string) => removedFromCase.push([userId, caseId]);
      (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);

      await EngagementAccessSvc.revoke({ requestId: "r1", caseId: "c1", lawyerId: "bob" });

      expect(removedFromCase).to.deep.equal([["bob", "c1"]]);
      expect(emitted).to.deep.equal([["bob", SHARED_CASES_CHANGED, { caseId: "c1", shared: false }]]);
    });

    it("audits the revoke as a system action", async () => {
      (OrganizationRepo as any).revokeCaseAccess = async () => true;
      (socket as any).emitToUser = () => {};
      (socket as any).removeUserFromCase = () => {};
      const recorded: unknown[] = [];
      (SecurityAuditSvc as any).record = async (input: unknown) => recorded.push(input);

      await EngagementAccessSvc.revoke({ requestId: "r1", caseId: "c1", lawyerId: "bob" });

      expect(recorded).to.deep.equal([
        {
          action: "case.access_revoked",
          actorId: null,
          organizationId: null,
          targetType: "user",
          targetId: "bob",
          caseId: "c1",
          payload: { requestId: "r1", engagement: true },
        },
      ]);
    });
  });
});
