"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../lib/prisma"));
class TodoRepo {
    static async createTask(todo) {
        return prisma_1.default.todo.create({ data: todo });
    }
    static async update(todo) {
        const { id, title, description } = todo;
        return prisma_1.default.todo.update({ where: { id }, data: { title, description } });
    }
    static async delete(id) {
        return prisma_1.default.todo.delete({ where: { id } });
    }
}
exports.default = TodoRepo;
//# sourceMappingURL=todo.repository.js.map