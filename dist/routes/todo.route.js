"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router = express_1.default.Router();
const todo_controller_1 = __importDefault(require("../controllers/todo.controller"));
router.post("/", todo_controller_1.default.createTask);
router.put("/:id", todo_controller_1.default.update);
router.delete("/:id", todo_controller_1.default.delete);
exports.default = router;
//# sourceMappingURL=todo.route.js.map