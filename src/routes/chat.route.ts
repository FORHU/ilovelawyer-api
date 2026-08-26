import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ChatCtrl from "../controllers/chat.controller";
import InviteCtrl from "../controllers/invite.controller";
import ParticipantCtrl from "../controllers/participant.controller";

const router = express.Router();

router.use(validSession);

router.get("/session", asyncHandler(ChatCtrl.getSession));
router.get("/consultations", asyncHandler(ChatCtrl.listConsultations));
router.post("/consultations", asyncHandler(ChatCtrl.createConsultation));
router.patch("/consultations/:consultationId", asyncHandler(ChatCtrl.renameConsultation));
router.delete("/consultations/:consultationId", asyncHandler(ChatCtrl.deleteConsultation));
router.get("/consultations/:consultationId/messages", asyncHandler(ChatCtrl.listMessages));
router.get("/consultations/:consultationId/related-cases", asyncHandler(ChatCtrl.getRelatedCases));
router.post("/consultations/:consultationId/relevant-chunks", asyncHandler(ChatCtrl.relevantChunks));
router.post("/consultations/:consultationId/messages", asyncHandler(ChatCtrl.sendMessage));
router.delete("/consultations/:consultationId/messages/:messageId", asyncHandler(ChatCtrl.deleteMessage));
router.post(
  "/consultations/:consultationId/messages/:messageId/audio-overview/audio",
  asyncHandler(ChatCtrl.generateAudioOverviewAudio),
);
router.get(
  "/consultations/:consultationId/messages/:messageId/audio-overview/audio/poll",
  asyncHandler(ChatCtrl.pollAudioOverviewAudio),
);

// Invites
router.post("/consultations/:consultationId/invites", asyncHandler(InviteCtrl.create));
router.get("/consultations/:consultationId/invites", asyncHandler(InviteCtrl.listByConsultation));
router.get("/invites/:id", asyncHandler(InviteCtrl.getById));
router.post("/invites/:id/accept", asyncHandler(InviteCtrl.accept));
router.delete("/invites/:id", asyncHandler(InviteCtrl.delete));

// Participants
router.get("/consultations/:consultationId/participants", asyncHandler(ParticipantCtrl.list));
router.delete("/consultations/:consultationId/participants/:userId", asyncHandler(ParticipantCtrl.remove));

export default router;
