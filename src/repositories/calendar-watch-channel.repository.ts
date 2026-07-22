import prisma from "../lib/prisma";

export default class CalendarWatchChannelRepo {
  static async findByChannelId(channelId: string) {
    return prisma.calendarWatchChannel.findUnique({ where: { channelId } });
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
