import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import ChatCtrl from "../controllers/chat.controller";

const router = express.Router();

router.use(validSession);

router.get("/session", asyncHandler(ChatCtrl.getSession));
router.post("/conversations", asyncHandler(ChatCtrl.createConversation));
router.get("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.listMessages));
router.post("/conversations/:conversationId/messages", asyncHandler(ChatCtrl.sendMessage));

export default router;
