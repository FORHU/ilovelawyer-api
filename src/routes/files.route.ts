import express from "express";
import multer from "multer";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import FilesCtrl from "../controllers/files.controller";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const router = express.Router();

router.post("/upload", validSession, upload.single("file"), asyncHandler(FilesCtrl.upload));
// Public by omission (no validSession): the browser never sends a Bearer header for an <a>,
// <audio> or <iframe> src, so ilovelawyer-app's Route Handler calls this server-to-server with
// only the proxy token as auth — see FilesSvc.resolve.
router.get("/resolve", asyncHandler(FilesCtrl.resolve));

export default router;
