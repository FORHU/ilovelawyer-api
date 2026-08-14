import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import TranscriptionCtrl from "../controllers/transcription.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(TranscriptionCtrl.list));
router.get("/:id", asyncHandler(TranscriptionCtrl.getById));
router.post("/", asyncHandler(TranscriptionCtrl.create));
router.post("/:id/start-job", asyncHandler(TranscriptionCtrl.startJob));
router.get("/:id/poll-job", asyncHandler(TranscriptionCtrl.pollJob));
router.post("/:id/chunk", asyncHandler(TranscriptionCtrl.chunk));
router.patch("/:id", asyncHandler(TranscriptionCtrl.update));
router.delete("/:id", asyncHandler(TranscriptionCtrl.delete));

export default router;
