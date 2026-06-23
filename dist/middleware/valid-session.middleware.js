"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const sessionMiddleware = (req, res, next) => {
    const scopedAuth = req.headers["scoped-auth"];
    if (scopedAuth && scopedAuth === config_1.SECRET_KEY)
        return next();
    const authorization = req.headers["authorization"];
    const token = authorization && authorization.split(" ")[1];
    if (!token)
        return res.status(401).json({ message: "Unauthorized" });
    jsonwebtoken_1.default.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
        if (err)
            return res.status(401).json({ message: "Authorization token expired" });
        req.user = user;
        next();
    });
};
exports.default = sessionMiddleware;
//# sourceMappingURL=valid-session.middleware.js.map