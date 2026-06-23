"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
// src/app.ts
const express_1 = __importDefault(require("express"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const helmet_1 = __importDefault(require("helmet"));
const routes_1 = __importDefault(require("./routes"));
const config_1 = require("./config");
const setup_1 = __importDefault(require("./setup"));
const cors_1 = __importDefault(require("cors"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const app = (0, express_1.default)();
app.set("trust proxy", 1);
app.use((0, cors_1.default)({
    origin: "*",
    credentials: true,
}));
app.use(express_1.default.json());
// Set up rate limiting middleware
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
});
if (!config_1.isDev)
    app.use(limiter);
// Set up security headers
app.use((0, helmet_1.default)());
app.disable("x-powered-by");
// Use router for routing
app.use("/api", routes_1.default);
const server = (0, http_1.createServer)(app);
exports.io = new socket_io_1.Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true,
    },
});
const events_1 = __importDefault(require("./events"));
(0, events_1.default)(exports.io);
(0, setup_1.default)().catch((err) => {
    console.log(err);
});
exports.default = server;
//# sourceMappingURL=app.js.map