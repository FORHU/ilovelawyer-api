import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import CaseRepo from "./case.repository";

export default class EventRepo {
  /**
   * clientEmail matching lets an event be found by the client's email even though they're not
   * an org member — kept as an OR alongside userId, but both are still nested inside a hard
   * organizationId AND so a match can never cross an org boundary.
   */
  static async findMany(organizationId: string, userId: string, userEmail: string, filters: {
    startRange?: string;
    endRange?: string;
    excludeId?: string;
    excludeStatus?: string;
    limitOne?: boolean;
    caseId?: string;
  } = {}) {
    const andConditions: any[] = [
      { organizationId },
      {
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
    ];

    if (filters.startRange) andConditions.push({ dateTime: { gte: new Date(filters.startRange) } });
    if (filters.endRange) andConditions.push({ dateTime: { lte: new Date(filters.endRange) } });
    if (filters.excludeId) andConditions.push({ id: { not: filters.excludeId } });
    if (filters.excludeStatus) andConditions.push({ status: { not: filters.excludeStatus } });
    if (filters.caseId) andConditions.push({ caseId: filters.caseId });

    return prisma.event.findMany({
      where: { AND: andConditions },
      include: {
        user: { select: { id: true, email: true, name: true, username: true } },
      },
      ...(filters.limitOne && { take: 1 }),
      orderBy: { dateTime: "asc" },
    });
  }

  static async findById(id: string, organizationId: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        id,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      include: {
        user: { select: { id: true, email: true, name: true, username: true } },
      },
    });
  }

  static async findByGoogleEventId(googleEventId: string, organizationId: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        googleEventId,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
    });
  }

  static async create(organizationId: string, userId: string, data: {
    title: string;
    type?: string;
    dateTime: Date;
    endDateTime?: Date;
    clientEmail?: string;
    notes?: string;
    status?: string;
    googleLink?: string;
    googleEventId?: string;
    caseId?: string;
    dateSource?: string;
    reminderLeadMinutes?: number;
    googleDirtyAt?: Date;
  }) {
    const created = await prisma.event.create({ data: { organizationId, userId, ...data } });
    CaseRepo.touchSafe(data.caseId);
    return created;
  }

  static async updateById(id: string, organizationId: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        id,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  static async updateByGoogleEventId(googleEventId: string, organizationId: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        googleEventId,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  /** No access filter — for GoogleCalendarSyncSvc, which always acts as the event's owner
   * (event.userId), whoever triggered the change. */
  static async findRawById(id: string) {
    return prisma.event.findUnique({ where: { id } });
  }

  /** Records (or, with nulls, forgets) the owner's Google Calendar copy of this event, and
   * Google's `updated` time for it — see Event.googleUpdatedAt. */
  static async setGoogleRef(
    id: string,
    googleEventId: string | null,
    googleLink: string | null,
    googleUpdatedAt?: string | Date | null,
  ) {
    return prisma.event.updateMany({
      where: { id },
      data: {
        googleEventId,
        googleLink,
        // Written by a push (or a forget): Google now matches the app, so nothing is pending.
        ...(googleUpdatedAt !== undefined
          ? { googleUpdatedAt: googleUpdatedAt ? new Date(googleUpdatedAt) : null, googleDirtyAt: null }
          : {}),
      },
    });
  }

  /** The owner's appointment whose Google copy is `googleEventId` (GoogleCalendarPullSvc). */
  static async findByOwnerGoogleEventId(userId: string, googleEventId: string) {
    return prisma.event.findFirst({ where: { userId, googleEventId } });
  }

  /** Writes a change that came from Google. Deliberately not through EventSvc, so it isn't
   * pushed straight back to Google. */
  static async applyGoogleChanges(id: string, data: Prisma.EventUpdateManyMutationInput) {
    return prisma.event.updateMany({ where: { id }, data });
  }

  static async deleteById(id: string, organizationId: string, userId: string) {
    return prisma.event.deleteMany({ where: { id, organizationId, userId } });
  }

  static async deleteByGoogleEventId(googleEventId: string, organizationId: string, userId: string) {
    return prisma.event.deleteMany({ where: { googleEventId, organizationId, userId } });
  }

  /**
   * Candidates for EventReminderQueue: not yet reminded, not cancelled, and due within
   * (now, windowEnd] — the exact `dateTime - reminderLeadMinutes` cutoff is checked by the
   * caller since Prisma can't compare two columns arithmetically in a `where`.
   */
  static async findDueForReminder(now: Date, windowEnd: Date) {
    return prisma.event.findMany({
      where: {
        reminderLeadMinutes: { not: null },
        lastReminderSentAt: null,
        status: { notIn: ["cancelled", "denied"] },
        dateTime: { gt: now, lte: windowEnd },
      },
      include: {
        user: { select: { email: true } },
        case: { select: { caseName: true } },
      },
    });
  }

  static async markReminderSent(id: string, sentAt: Date) {
    return prisma.event.update({ where: { id }, data: { lastReminderSentAt: sentAt } });
  }
}
