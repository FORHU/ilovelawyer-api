import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

export default class FilesRepo {
  static async create(filename: string, fileUrl: string, s3Key: string, metaData?: Prisma.InputJsonValue) {
    return prisma.file.create({ data: { filename, fileUrl, s3Key, metaData } });
  }

  static async createFile(payload: Express.FileTypes[], client: DbClient = prisma) {
    return client.file.createManyAndReturn({ data: payload });
  }
}
