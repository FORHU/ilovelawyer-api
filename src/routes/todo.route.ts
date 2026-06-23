import express from "express";
const router = express.Router();

import TodoCtrl from "../controllers/todo.controller";

router.post("/", TodoCtrl.createTask);
router.put("/:id", TodoCtrl.update);
router.delete("/:id", TodoCtrl.delete);

export default router;
