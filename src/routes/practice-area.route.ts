import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import PracticeAreaCtrl from "../controllers/practice-area.controller";

const router = express.Router();

router.use(validSession);

// The practice areas a lawyer can pick on their Lawyer Application, per site.
router.get("/", asyncHandler(PracticeAreaCtrl.list));

export default router;
