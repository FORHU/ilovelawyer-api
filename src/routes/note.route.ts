import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import resolveOrganization from "../middleware/resolve-organization.middleware";
import NoteCtrl from "../controllers/note.controller";

const router = express.Router();

router.use(validSession, asyncHandler(resolveOrganization));

router.get("/", asyncHandler(NoteCtrl.list));
router.post("/", asyncHandler(NoteCtrl.create));

export default router;
