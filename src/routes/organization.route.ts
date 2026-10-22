import express from "express";
import { OrganizationRole } from "@prisma/client";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { resolveOrganizationFromParam } from "../middleware/resolve-organization.middleware";
import { requireOrgRole } from "../utils/org-role";
import OrganizationCtrl from "../controllers/organization.controller";
import SecurityAuditCtrl from "../controllers/security-audit.controller";
import OrganizationCardCtrl from "../controllers/organization-card.controller";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(OrganizationCtrl.create));
router.get("/", asyncHandler(OrganizationCtrl.list));

// The caller's own pending invite. Deliberately not gated by resolveOrganizationFromParam
// (which requires an already-ACCEPTED membership) — a pending invitee has none yet.
router.get("/invites/me", asyncHandler(OrganizationCtrl.getMyInvite));

// The caller's own portfolio (their personal workspace) — reachable whatever org they're in.
router.get("/portfolio", asyncHandler(OrganizationCtrl.getPortfolio));
router.post("/invites/:id/accept", asyncHandler(OrganizationCtrl.acceptInvite));
router.post("/invites/:id/decline", asyncHandler(OrganizationCtrl.declineInvite));

// Everything below acts on a specific org named in the URL, so membership is
// resolved from :id (not the X-Organization-Id header used by resource routes).
router.get("/:id", asyncHandler(resolveOrganizationFromParam()), asyncHandler(OrganizationCtrl.getById));
router.patch(
  "/:id",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCtrl.update),
);

router.get("/:id/members", asyncHandler(resolveOrganizationFromParam()), asyncHandler(OrganizationCtrl.listMembers));
router.post(
  "/:id/members",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCtrl.inviteMember),
);
router.patch(
  "/:id/members/:userId",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCtrl.changeMemberRole),
);
// Self-service leave, no role requirement — must be registered before the
// wildcard :userId route below, or "me" would be captured as a userId and
// routed to removeMember instead.
router.delete(
  "/:id/members/me",
  asyncHandler(resolveOrganizationFromParam()),
  asyncHandler(OrganizationCtrl.leave),
);
router.delete(
  "/:id/members/:userId",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCtrl.removeMember),
);

// Case-attachment requires the caller to be a member of the target org (not a
// specific role — OrganizationSvc.attachCase itself checks edit access on the case
// being attached, see CaseAccess.assertCanEdit), so no requireOrgRole here.
router.post("/:id/cases", asyncHandler(resolveOrganizationFromParam()), asyncHandler(OrganizationCtrl.attachCase));

// The firm's security audit log (docs/adr/0006-security-audit-log.md) — Owners and Admins only.
router.get(
  "/:id/audit-log",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(SecurityAuditCtrl.listForOrganization),
);
router.get(
  "/:id/audit-log/export",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(SecurityAuditCtrl.exportForOrganization),
);

// The firm's card on file for the client hand-off's per-case fee (ilovelawyer-api#505): Owners and
// Admins only, to see it as well as to change it.
router.get(
  "/:id/billing/card",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCardCtrl.get),
);
router.get(
  "/:id/billing/fees",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCardCtrl.fees),
);
router.post(
  "/:id/billing/card/setup-session",
  asyncHandler(resolveOrganizationFromParam()),
  requireOrgRole(OrganizationRole.ADMIN),
  asyncHandler(OrganizationCardCtrl.startSetup),
);

export default router;
