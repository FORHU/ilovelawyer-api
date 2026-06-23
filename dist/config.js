"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVICE_ACCOUNT = exports.REDIS_PASSWORD = exports.REDIS_PORT = exports.REDIS_HOST = exports.ACCESS_TOKEN_EXPIRY = exports.REFRESH_TOKEN_SECRET = exports.ACCESS_TOKEN_SECRET = exports.MAILER_PASSWORD = exports.MAILER_EMAIL = exports.MAILER_TRANSPORT_SECURE = exports.MAILER_TRANSPORT_PORT = exports.MAILER_TRANSPORT_HOST = exports.isDev = exports.SECRET_KEY = exports.PORT = exports.DATABASE_URL = void 0;
const dotenv = __importStar(require("dotenv"));
dotenv.config();
exports.DATABASE_URL = process.env.DATABASE_URL;
exports.PORT = Number(process.env.PORT || 3001);
exports.SECRET_KEY = process.env.SECRET_KEY;
exports.isDev = process.env.NODE_ENV !== "production";
exports.MAILER_TRANSPORT_HOST = process.env.MAILER_TRANSPORT_HOST;
exports.MAILER_TRANSPORT_PORT = Number(process.env.MAILER_TRANSPORT_PORT || 465);
exports.MAILER_TRANSPORT_SECURE = process.env.MAILER_TRANSPORT_SECURE === "true";
exports.MAILER_EMAIL = process.env.MAILER_EMAIL;
exports.MAILER_PASSWORD = process.env.MAILER_PASSWORD;
exports.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
exports.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
exports.ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY;
exports.REDIS_HOST = process.env.REDIS_HOST;
exports.REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
exports.REDIS_PASSWORD = process.env.REDIS_PASSWORD;
exports.SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT;
//# sourceMappingURL=config.js.map