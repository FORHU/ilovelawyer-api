"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const redis_util_1 = __importDefault(require("./utils/redis.util"));
exports.default = async () => {
    await redis_util_1.default.initialize();
};
//# sourceMappingURL=setup.js.map