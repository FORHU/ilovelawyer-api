import prisma from "../lib/prisma";
import { ProductTourStatus } from "@prisma/client";

export default class ProductTourRepo {
  static async find(userId: string, track: string) {
    return prisma.productTour.findUnique({ where: { userId_track: { userId, track } } });
  }

  static async upsert(
    userId: string,
    track: string,
    data: { status: ProductTourStatus; archetype: string | null; currentStep: string | null; doneSteps: string[] },
  ) {
    return prisma.productTour.upsert({
      where: { userId_track: { userId, track } },
      create: { userId, track, ...data },
      update: data,
    });
  }
}
