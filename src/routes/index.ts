import express from "express";
import authRoute from "./auth.route";
import chatRoute from "./chat.route";

const router = express.Router();

router.get("/v1", (_, res) => {
  res.json({
    message: "Welcome to my API",
  });
});

router.use("/auth", authRoute);
router.use("/chat", chatRoute);

export default router;
