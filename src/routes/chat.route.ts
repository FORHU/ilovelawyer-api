import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ChatCtrl from "../controllers/chat.controller";
import InviteCtrl from "../controllers/invite.controller";
import ParticipantCtrl from "../controllers/participant.controller";

const router = express.Router();

router.use(validSession);

router.get("/session", asyncHandler(ChatCtrl.getSession));
router.get("/conversations", asyncHandler(ChatCtrl.listConversations));
router.post("/conversations", asyncHandler(ChatCtrl.createConversation));
router.patch("/conversations/:conversationId", asyncHandler(ChatCtrl.renameConversation));
router.delete("/conversations/:conversationId", asyncHandler(ChatCtrl.deleteConversation));
router.get("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.listMessages));
router.get("/conversations/:conversationId/related-cases", asyncHandler(ChatCtrl.getRelatedCases));
router.post("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.sendMessage));
router.delete("/conversations/:conversationId/messages/:messageId", asyncHandler(ChatCtrl.deleteMessage));

// Invites
router.post("/conversations/:conversationId/invites", asyncHandler(InviteCtrl.create));
router.get("/conversations/:conversationId/invites", asyncHandler(InviteCtrl.listByConversation));
router.get("/invites/:id", asyncHandler(InviteCtrl.getById));
router.post("/invites/:id/accept", asyncHandler(InviteCtrl.accept));
router.delete("/invites/:id", asyncHandler(InviteCtrl.delete));

// Participants
router.get("/conversations/:conversationId/participants", asyncHandler(ParticipantCtrl.list));
router.delete("/conversations/:conversationId/participants/:userId", asyncHandler(ParticipantCtrl.remove));

export default router;
