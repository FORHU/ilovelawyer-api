// src/app.ts
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import router from "./routes";
import StripeWebhookCtrl from "./controllers/stripe-webhook.controller";
import asyncHandler from "./utils/async-handler";
import errorHandler from "./middleware/error-handler.middleware";
import { isDev, CLIENT_URL } from "./config";
import setup from "./setup";
import swaggerSpec from "./swagger";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { initSocket } from "./lib/socket";
import { requestContextMiddleware } from "./lib/request-context";

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);

// Stripe signs the exact bytes it sends, so its webhook takes the raw body and must stay ahead of
// express.json() below. Moving it after the JSON parser breaks every signature. It sits under /api
// because the hosts that share a domain with a frontend (uk-dev, uk.ilovelawyer.com) only route
// /api/* to this server; matched here first, it never reaches the /api router.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }), asyncHandler(StripeWebhookCtrl.handle));

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
// After the body parsers, which can drop AsyncLocalStorage context across their callbacks.
app.use(requestContextMiddleware);

// Set up rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
});

if (!isDev) app.use(limiter);

// Set up security headers
app.use(helmet());
app.disable("x-powered-by");

// The raw spec, for the frontends to generate types from and mock planned routes against.
app.get("/api-docs.json", (_req, res) => res.json(swaggerSpec));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Use router for routing
app.use("/api", router);
app.use("/api/v1", router);

// Must be mounted last: catches errors forwarded via asyncHandler/next(err)
app.use(errorHandler);

const server = createServer(app);

initSocket(server);

setup().catch((err) => {
  console.log(err);
});

export default server;
