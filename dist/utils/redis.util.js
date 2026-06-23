"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("redis");
const config_1 = require("../config");
class RedisUtil {
    static async initialize() {
        this.redisClient = await (0, redis_1.createClient)({
            password: config_1.REDIS_PASSWORD,
            socket: {
                host: config_1.REDIS_HOST,
                port: config_1.REDIS_PORT,
            },
        });
    }
    static useConnection() {
        return this.redisClient;
    }
}
exports.default = RedisUtil;
//# sourceMappingURL=redis.util.js.map