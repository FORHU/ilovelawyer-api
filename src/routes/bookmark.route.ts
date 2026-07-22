import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import BookmarkCtrl from "../controllers/bookmark.controller";

const router = express.Router();

router.use(validSession);

router.get("/", asyncHandler(BookmarkCtrl.list));
router.get("/check", asyncHandler(BookmarkCtrl.checkByItemId));
router.get("/:id", asyncHandler(BookmarkCtrl.getById));
router.post("/", asyncHandler(BookmarkCtrl.create));
router.delete("/:id", asyncHandler(BookmarkCtrl.delete));

export default router;
