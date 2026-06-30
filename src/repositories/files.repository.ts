import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

export default class FilesRepo {
  static async create(filename: string, fileUrl: string, metaData?: Prisma.InputJsonValue) {
    return prisma.file.create({ data: { filename, fileUrl, metaData } });
  }
}
