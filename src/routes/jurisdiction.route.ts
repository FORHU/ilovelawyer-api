import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import JurisdictionCtrl, { IntegrationCtrl } from "../controllers/jurisdiction.controller";

const jurisdictionRouter = express.Router();
jurisdictionRouter.use(validSession);
jurisdictionRouter.get("/", asyncHandler(JurisdictionCtrl.list));
jurisdictionRouter.patch("/:code", asyncHandler(JurisdictionCtrl.setEnabled));

const integrationRouter = express.Router();
integrationRouter.use(validSession);
integrationRouter.get("/", asyncHandler(IntegrationCtrl.list));
integrationRouter.post("/", asyncHandler(IntegrationCtrl.create));
integrationRouter.post("/:id/connect", asyncHandler(IntegrationCtrl.connect));
integrationRouter.post("/:id/disconnect", asyncHandler(IntegrationCtrl.disconnect));

export { jurisdictionRouter, integrationRouter };
