// src/app.ts
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import router from "./routes";
import errorHandler from "./middleware/error-handler.middleware";
import { isDev, CLIENT_URL } from "./config";
import setup from "./setup";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: CLIENT_URL,
  }),
);

app.use(express.json());

// Set up rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

if (!isDev) app.use(limiter);

// Set up security headers
app.use(helmet());
app.disable("x-powered-by");

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
