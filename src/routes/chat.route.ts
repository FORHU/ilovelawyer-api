import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ChatCtrl from "../controllers/chat.controller";

const router = express.Router();

router.use(validSession);

router.get("/session", asyncHandler(ChatCtrl.getSession));
router.get("/conversations", asyncHandler(ChatCtrl.listConversations));
router.post("/conversations", asyncHandler(ChatCtrl.createConversation));
router.patch("/conversations/:conversationId", asyncHandler(ChatCtrl.renameConversation));
router.delete("/conversations/:conversationId", asyncHandler(ChatCtrl.deleteConversation));
router.get("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.listMessages));
router.post("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.sendMessage));
router.delete("/conversations/:conversationId/messages/:messageId", asyncHandler(ChatCtrl.deleteMessage));

export default router;
