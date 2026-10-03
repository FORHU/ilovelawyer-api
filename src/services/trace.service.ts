import CaseAccess from "../utils/case-access";
import TraceRepo from "../repositories/trace.repository";
import { promptTitle } from "../utils/trace-stream.utils";

export interface TraceTurnSummary {
  turnId: string;
  /** 1-based position among this case's traced turns, oldest first — the pager's "Turn N". */
  number: number;
  title: string;
  userId: string | null;
  /** Null for a member who has since been removed; the pane shows "Former member". */
  userName: string | null;
  startedAt: Date;
  eventCount: number;
}

export interface TraceEventDto {
  seq: number;
  type: string;
  summary: string;
  createdAt: Date;
}

/**
 * Read side of the Terminal's trace pane, authorised like every other case panel: the caller must
 * be able to open the case (CaseAccess.loadAccessibleCase — organization membership plus any
 * per-case grant). On a shared case everyone who can open it sees every member's traces, each
 * attributed to who asked; `memberId` narrows the list to one member.
 */
export default class TraceSvc {
  /** Turn headers, oldest first. `number` is assigned over ALL traced turns, so a turn keeps its
   * number when the list is filtered to one member. */
  static async listTurns(caseId: string, callerId: string, memberId?: string): Promise<TraceTurnSummary[]> {
    await CaseAccess.loadAccessibleCase(caseId, callerId);
    const all = await TraceRepo.listTurnHeaders(caseId);
    const numberOf = new Map<string, number>();
    [...all].reverse().forEach((h, i) => numberOf.set(h.turnId, i + 1));
    const headers = memberId ? all.filter((h) => h.userId === memberId) : all;

    const [prompts, names] = await Promise.all([
      TraceRepo.promptsByMessageId(headers.map((h) => h.turnId)),
      TraceRepo.namesByUserId([...new Set(headers.flatMap((h) => (h.userId ? [h.userId] : [])))]),
    ]);

    return headers
      .map((h) => ({
        turnId: h.turnId,
        number: numberOf.get(h.turnId)!,
        title: promptTitle(prompts.get(h.turnId), numberOf.get(h.turnId)!),
        userId: h.userId,
        userName: h.userId ? (names.get(h.userId) ?? null) : null,
        startedAt: h.startedAt,
        eventCount: h.eventCount,
      }))
      .reverse();
  }

  /** One turn's events in order. Pass the last `seq` seen as `afterSeq` to get only what is new —
   * how the pane follows a turn that is still being generated. */
  static async listTurnEvents(caseId: string, callerId: string, turnId: string, afterSeq = 0): Promise<TraceEventDto[]> {
    await CaseAccess.loadAccessibleCase(caseId, callerId);
    return TraceRepo.listTurnEvents(caseId, turnId, afterSeq);
  }
}
