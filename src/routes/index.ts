import express from "express";
import todoRoute from "./todo.route";

const router = express.Router();

router.get("/v1", (_, res) => {
  res.json({
    message: "Welcome to my API",
  });
});

router.use("/todo", todoRoute);

export default router;
