import CaseAccess from "../utils/case-access";
import TraceRepo from "../repositories/trace.repository";
import { promptTitle } from "../utils/trace-stream.utils";

export interface TraceTurnSummary {
  turnId: string;
  /** What produced the run: "chat" for a question, otherwise the pane's generation (TRACE_SOURCES). */
  source: string;
  /** 1-based position among this case's runs of the same source, oldest first — "Question 3",
   * "Witness scoring 2". Counted over every run of that source, so a filter never renumbers it. */
  number: number;
  /** What was asked, flattened to one line — a chat question only. Null for a pane's generation,
   * which has no question; the pane names it by its source and number. */
  title: string | null;
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
 *
 * Every kind of run is listed — chat questions and the panes' own generations — each named by its
 * source and numbered within it. The pane filters by source; the list itself is not narrowed.
 */
export default class TraceSvc {
  /** Turn headers, oldest first. `number` is assigned over ALL runs of the same source, so a run
   * keeps its number when the list is filtered to one member. */
  static async listTurns(caseId: string, callerId: string, memberId?: string): Promise<TraceTurnSummary[]> {
    await CaseAccess.loadAccessibleCase(caseId, callerId);
    const all = await TraceRepo.listTurnHeaders(caseId);
    const numberOf = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const h of [...all].reverse()) {
      const n = (seen.get(h.source) ?? 0) + 1;
      seen.set(h.source, n);
      numberOf.set(h.turnId, n);
    }
    const headers = memberId ? all.filter((h) => h.userId === memberId) : all;

    const [prompts, names] = await Promise.all([
      // Only a chat turn is a user Message with a question to show.
      TraceRepo.promptsByMessageId(headers.filter((h) => h.source === "chat").map((h) => h.turnId)),
      TraceRepo.namesByUserId([...new Set(headers.flatMap((h) => (h.userId ? [h.userId] : [])))]),
    ]);

    return headers
      .map((h) => ({
        turnId: h.turnId,
        source: h.source,
        number: numberOf.get(h.turnId)!,
        title: h.source === "chat" ? promptTitle(prompts.get(h.turnId), numberOf.get(h.turnId)!) : null,
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
