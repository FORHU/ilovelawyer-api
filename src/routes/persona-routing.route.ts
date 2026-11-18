import express from "express";
import asyncHandler from "../utils/async-handler";
import apiKeyMiddleware from "../middleware/api-key.middleware";
import PersonaRoutingOverrideCtrl from "../controllers/persona-routing-override.controller";

// chat-wonder-v2-api's read side only (CW-8) — writes go through /admin/persona-routing,
// guarded by a human admin session, not this shared key.
const router = express.Router();

router.use(apiKeyMiddleware);

router.get("/", asyncHandler(PersonaRoutingOverrideCtrl.listForChatWonder));

export default router;
