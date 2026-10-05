import prisma from "../lib/prisma";

export interface TraceEventInsert {
  consultationId: string;
  caseId: string | null;
  organizationId: string;
  turnId: string;
  userId: string | null;
  sessionId: string;
  type: string;
  summary: string;
  createdAt: Date;
}

export interface TurnHeader {
  turnId: string;
  userId: string | null;
  firstSeq: number;
  startedAt: Date;
  eventCount: number;
}

/** A turn header list longer than this is cut to the newest turns. A pager over hundreds of turns
 * is already past what the pane can usefully show, and each header is one row, so this is a
 * guard against an unbounded response rather than a limit anyone should reach. */
export const MAX_TURN_HEADERS = 500;

export default class TraceRepo {
  static async insertEvent(event: TraceEventInsert) {
    return prisma.consultationTraceEvent.create({ data: event, select: { seq: true } });
  }

  /** One header per turn of the case that has any trace, newest first — across all of the case's
   * consultations, since on a shared case several members each have their own. */
  static async listTurnHeaders(caseId: string): Promise<TurnHeader[]> {
    const groups = await prisma.consultationTraceEvent.groupBy({
      by: ["turnId", "userId"],
      where: { caseId },
      _min: { seq: true, createdAt: true },
      _count: { _all: true },
      orderBy: { _min: { seq: "desc" } },
      take: MAX_TURN_HEADERS,
    });
    return groups.map((g) => ({
      turnId: g.turnId,
      userId: g.userId,
      firstSeq: g._min.seq!,
      startedAt: g._min.createdAt!,
      eventCount: g._count._all,
    }));
  }

  /** Events of one turn in order. `afterSeq` is the resume cursor for a pane that is polling a
   * turn still being generated: it asks only for what it has not seen. */
  static async listTurnEvents(caseId: string, turnId: string, afterSeq = 0) {
    return prisma.consultationTraceEvent.findMany({
      where: { caseId, turnId, seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true, summary: true, userId: true, createdAt: true },
    });
  }

  /** Display data for the pane's turn headers: what was asked (the user Message's text) and
   * who asked (name joined now, so a rename shows up and a removed user reads as former). */
  static async promptsByMessageId(messageIds: string[]) {
    if (messageIds.length === 0) return new Map<string, string>();
    const rows = await prisma.message.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, content: true },
    });
    return new Map(rows.map((r) => [r.id, r.content]));
  }

  static async namesByUserId(userIds: string[]) {
    if (userIds.length === 0) return new Map<string, string | null>();
    const rows = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
