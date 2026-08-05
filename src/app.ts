// src/app.ts
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import router from "./routes";
import errorHandler from "./middleware/error-handler.middleware";
import { isDev, CLIENT_URL } from "./config";
import setup from "./setup";
import swaggerSpec from "./swagger";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    // Custom response headers are invisible to frontend fetch() calls across origins
    // unless explicitly exposed — X-Chat-Session-Id lets the client silently pick up a
    // rotated Chat Wonder session_id (see ChatCtrl.sendMessage) without needing an error.
    exposedHeaders: ["X-Chat-Session-Id"],
  }),
);

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Set up rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
});

if (!isDev) app.use(limiter);

// Set up security headers
app.use(helmet());
app.disable("x-powered-by");

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Use router for routing
app.use("/api", router);

// Must be mounted last: catches errors forwarded via asyncHandler/next(err)
app.use(errorHandler);

const server = createServer(app);

export const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

import events from "./events";

events(io);

setup().catch((err) => {
  console.log(err);
});

export default server;
