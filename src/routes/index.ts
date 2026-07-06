import express from "express";
import authRoute from "./auth.route";
import chatRoute from "./chat.route";
import legalRagRoute from "./legal-rag.route";
import filesRoute from "./files.route";
import usersRoute from "./users.route";
import caseRoute from "./case.route";
import bookmarkRoute from "./bookmark.route";
import userDocumentRoute from "./user-document.route";
import legalSourceCacheRoute from "./legal-source-cache.route";
import transcriptionRoute from "./transcription.route";

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
router.use("/bookmarks", bookmarkRoute);
router.use("/documents", userDocumentRoute);
router.use("/legal-source-analysis", legalSourceCacheRoute);
router.use("/transcriptions", transcriptionRoute);

export default router;
