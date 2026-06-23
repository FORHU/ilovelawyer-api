import prisma from "../lib/prisma";
import { TTodo, TTodoUpdateOptions } from "../models/todo.model";

export default class TodoRepo {
  static async createTask(todo: TTodo) {
    return prisma.todo.create({ data: todo });
  }

  static async update(todo: TTodoUpdateOptions) {
    const { id, title, description } = todo;
    return prisma.todo.update({ where: { id }, data: { title, description } });
  }

  static async delete(id: string) {
    return prisma.todo.delete({ where: { id } });
  }
}
