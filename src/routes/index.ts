import express from "express";
import authRoute from "./auth.route";
import chatRoute from "./chat.route";
import legalRagRoute from "./legal-rag.route";
import filesRoute from "./files.route";
import usersRoute from "./users.route";
import caseRoute from "./case.route";

const router = express.Router();

router.get("/v1", (_, res) => {
  res.json({
    message: "Welcome to my API",
  });
});

router.use("/auth", authRoute);
router.use("/chat", chatRoute);
router.use("/legal-rag", legalRagRoute);
router.use("/files", filesRoute);
router.use("/users", usersRoute);
router.use("/my-cases", caseRoute);

export default router;
