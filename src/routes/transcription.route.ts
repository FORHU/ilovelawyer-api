import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { resolveOrganizationAllowingGuests } from "../middleware/resolve-organization.middleware";
import { guestItemNeedsCase, guestListNeedsCase, transcriptionCaseOf } from "../middleware/guest-case-items.middleware";
import TranscriptionCtrl from "../controllers/transcription.controller";

const router = express.Router();

// Allows guests: a read-only share of a portfolio case reaches it here (see the middleware).
router.use(validSession, asyncHandler(resolveOrganizationAllowingGuests));
router.param("id", guestItemNeedsCase(transcriptionCaseOf));

router.get("/", guestListNeedsCase, asyncHandler(TranscriptionCtrl.list));
router.get("/:id", asyncHandler(TranscriptionCtrl.getById));
router.post("/", asyncHandler(TranscriptionCtrl.create));
router.post("/:id/start-job", asyncHandler(TranscriptionCtrl.startJob));
router.get("/:id/poll-job", asyncHandler(TranscriptionCtrl.pollJob));
router.post("/:id/chunk", asyncHandler(TranscriptionCtrl.chunk));
router.patch("/:id", asyncHandler(TranscriptionCtrl.update));
router.delete("/:id", asyncHandler(TranscriptionCtrl.delete));

export default router;
