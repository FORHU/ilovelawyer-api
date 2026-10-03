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

  /** How many of `tracks` the user has finished — completed or dismissed. */
  static async countFinished(userId: string, tracks: readonly string[]) {
    return prisma.productTour.count({
      where: { userId, track: { in: [...tracks] }, status: { in: [ProductTourStatus.COMPLETED, ProductTourStatus.DISMISSED] } },
    });
  }
}
