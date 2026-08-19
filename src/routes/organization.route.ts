import express from "express";
import { OrganizationRole } from "@prisma/client";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { resolveOrganizationFromParam } from "../middleware/resolve-organization.middleware";
import { requireOrgRole } from "../utils/org-role";
import OrganizationCtrl from "../controllers/organization.controller";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(OrganizationCtrl.create));
router.get("/", asyncHandler(OrganizationCtrl.list));

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

// Case-attachment isn't gated by org role — OrganizationSvc.attachCase itself checks
// edit access to the case being attached (see CaseAccess.assertCanEdit), not org
// membership, so no resolveOrganizationFromParam/requireOrgRole here.
router.post("/:id/cases", asyncHandler(OrganizationCtrl.attachCase));

export default router;
