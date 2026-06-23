"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const todo_repository_1 = __importDefault(require("../repositories/todo.repository"));
class TodoSvc {
    static createTask(task) {
        return todo_repository_1.default.createTask(task);
    }
    static update(task) {
        return todo_repository_1.default.update(task);
    }
    static delete(id) {
        return todo_repository_1.default.delete(id);
    }
}
exports.default = TodoSvc;
//# sourceMappingURL=todo.service.js.map