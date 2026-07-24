import express from "express";
import multer from "multer";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import UserDocumentCtrl from "../controllers/user-document.controller";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(UserDocumentCtrl.list));
router.get("/:id", asyncHandler(UserDocumentCtrl.getById));
router.post("/", upload.single("file"), asyncHandler(UserDocumentCtrl.upload));
router.patch("/:id", asyncHandler(UserDocumentCtrl.update));
router.delete("/:id", asyncHandler(UserDocumentCtrl.delete));

export default router;
