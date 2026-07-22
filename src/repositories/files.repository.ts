import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

export default class FilesRepo {
  static async create(filename: string, fileUrl: string, s3Key: string, metaData?: Prisma.InputJsonValue) {
    return prisma.file.create({ data: { filename, fileUrl, s3Key, metaData } });
  }
}
