"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_route_1 = __importDefault(require("./auth.route"));
const router = express_1.default.Router();
router.get("/v1", (_, res) => {
    res.json({
        message: "Welcome to my API",
    });
});
router.use("/auth", auth_route_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map