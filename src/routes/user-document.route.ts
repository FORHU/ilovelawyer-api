import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import UserDocumentCtrl from "../controllers/user-document.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(UserDocumentCtrl.list));
router.get("/:id", asyncHandler(UserDocumentCtrl.getById));
router.post("/presign", asyncHandler(UserDocumentCtrl.presign));
router.post("/", asyncHandler(UserDocumentCtrl.create));
router.patch("/:id", asyncHandler(UserDocumentCtrl.update));
router.delete("/:id", asyncHandler(UserDocumentCtrl.delete));

export default router;
