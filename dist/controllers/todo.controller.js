"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const joi_1 = __importDefault(require("joi"));
const todo_service_1 = __importDefault(require("../services/todo.service"));
class TodoCtrl {
    static async createTask(req, res) {
        const { title, description } = req.body;
        const schema = joi_1.default.object({
            title: joi_1.default.string().required(),
            description: joi_1.default.string().required(),
        });
        const { error } = schema.validate({ title, description });
        if (error) {
            return res.status(400).json({ message: error.message });
        }
        try {
            const result = await todo_service_1.default.createTask({ title, description });
            return res.json({ message: result });
        }
        catch (error) {
            return res.status(500).json({ message: error });
        }
    }
    static async update(req, res) {
        const { title, description, status } = req.body;
        const id = req.params.id;
        const schema = joi_1.default.object({
            title: joi_1.default.string().required(),
            description: joi_1.default.string().required(),
        });
        const { error } = schema.validate({ title, description, status });
        if (error) {
            return res.status(400).json({ message: error.message });
        }
        try {
            const result = await todo_service_1.default.update({ id, title, description });
            return res.json({ message: result });
        }
        catch (error) {
            return res.status(500).json({ message: error });
        }
    }
    static async delete(req, res) {
        const id = req.params.id;
        try {
            const result = await todo_service_1.default.delete(id);
            return res.json({ message: result });
        }
        catch (error) {
            return res.status(500).json({ message: error });
        }
    }
}
exports.default = TodoCtrl;
//# sourceMappingURL=todo.controller.js.map