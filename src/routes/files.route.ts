import express from "express";
import multer from "multer";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import FilesCtrl from "../controllers/files.controller";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

router.use(validSession);

router.post("/upload", upload.single("file"), asyncHandler(FilesCtrl.upload));

export default router;
