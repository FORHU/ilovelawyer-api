import prisma from "../lib/prisma";

export default class CalendarWatchChannelRepo {
  static async findByChannelId(channelId: string) {
    return prisma.calendarWatchChannel.findUnique({ where: { channelId } });
  }

  static async findForUser(userId: string) {
    return prisma.calendarWatchChannel.findFirst({ where: { userId } });
  }

  static async deleteForUser(userId: string) {
    return prisma.calendarWatchChannel.deleteMany({ where: { userId } });
  }

  static async replaceForUser(userId: string, data: {
    channelId: string;
    resourceId: string;
    expiration: bigint;
  }) {
    await prisma.calendarWatchChannel.deleteMany({ where: { userId } });
    return prisma.calendarWatchChannel.create({ data: { userId, ...data } });
  }
}
