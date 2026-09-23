import prisma from "../lib/prisma";
import { TimelineSource } from "@prisma/client";
import { AI_KEY_DATE_STATUS } from "../constants";

export interface TimelineInput {
  title: string;
  occurredOn?: Date | null;
  description?: string | null;
  status?: string;
  source?: TimelineSource;
  documentId?: string | null;
  chunkId?: string | null;
  pageNumber?: number | null;
  createdBy?: string | null;
}

export default class CaseTimelineRepo {
  static async list(caseId: string) {
    return prisma.caseTimelineEvent.findMany({
      where: { caseId },
      orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }],
    });
  }

  static async create(caseId: string, data: TimelineInput) {
    return prisma.caseTimelineEvent.create({ data: { caseId, ...data } });
  }

  /**
   * Syncs the case's AI-sourced key dates against `items` — the full set a single case-strategy
   * run just derived — without wiping rows the model simply didn't mention *this* time. Full
   * delete-then-recreate (the previous behavior) meant a run whose reply happened to omit a date
   * it correctly found last time silently erased it. Instead:
   *  - a row tied to a document in `documentIds` (this run's READY set) that isn't in `items`
   *    anymore is dropped — the run considered that document and no longer reports the date;
   *  - a row tied to a document OUTSIDE `documentIds` is left alone — out of scope for this run;
   *  - a row with no documentId (legacy, or a date the model couldn't attribute) is dropped and
   *    only re-created if `items` still reports it, same as the old wipe-and-recreate behavior,
   *    since there's no document to scope it to;
   *  - anything already present under the same (documentId, title, occurredOn) key is left as-is
   *    (no churn of its id/createdAt on every run).
   */
  /** Returns, alongside the case's full timeline, `aiKeyDateIds` — every AI key-date row that
   * exists after this sync (both rows just created and ones left untouched) — and `deletedIds`.
   * The caller (CaseTimelineSvc.replaceDocumentDates) uses these to keep CaseGraphNode in sync:
   * a CaseTimelineEvent with no corresponding graph node is invisible to CaseGraphViewSvc's
   * "timeline" view (it only ever reads CaseGraphNode, never CaseTimelineEvent directly), so
   * every id here — not just newly-created ones — needs its node (re-)ensured on every call, since
   * an id already present in `aiKeyDateIds` from an earlier run, before this bookkeeping existed,
   * would otherwise never get backfilled. `createMany` can't return the rows it inserted, hence
   * individual `create` calls here instead — the set is small (MAX_ITEMS.DATES = 20 per run). */
  static async replaceAiKeyDates(
    caseId: string,
    documentIds: string[],
    items: { title: string; occurredOn: Date; documentId?: string | null; pageNumber?: number | null; createdBy?: string | null }[],
  ) {
    const documentIdSet = new Set(documentIds);
    const keyOf = (documentId: string | null, title: string, occurredOn: Date | null) =>
      `${documentId ?? "none"}|${title.toLowerCase()}|${occurredOn?.toISOString() ?? "none"}`;

    const { aiKeyDateIds, deletedIds } = await prisma.$transaction(async (tx) => {
      const existing = await tx.caseTimelineEvent.findMany({
        where: { caseId, source: "AI", status: AI_KEY_DATE_STATUS },
      });
      const incomingKeys = new Set(
        items.map((item) => keyOf(item.documentId ?? null, item.title, item.occurredOn)),
      );

      const staleIds = existing
        .filter((row) => {
          const inScope = row.documentId ? documentIdSet.has(row.documentId) : true;
          if (!inScope) return false;
          return !incomingKeys.has(keyOf(row.documentId, row.title, row.occurredOn));
        })
        .map((row) => row.id);
      if (staleIds.length) {
        await tx.caseTimelineEvent.deleteMany({ where: { id: { in: staleIds } } });
      }

      const staleIdSet = new Set(staleIds);
      const kept = existing.filter((row) => !staleIdSet.has(row.id));
      const existingKeys = new Set(kept.map((row) => keyOf(row.documentId, row.title, row.occurredOn)));
      const toCreate = items.filter(
        (item) => !existingKeys.has(keyOf(item.documentId ?? null, item.title, item.occurredOn)),
      );
      const created = await Promise.all(
        toCreate.map((item) =>
          tx.caseTimelineEvent.create({
            data: {
              caseId,
              title: item.title,
              occurredOn: item.occurredOn,
              status: AI_KEY_DATE_STATUS,
              source: "AI",
              documentId: item.documentId ?? null,
              pageNumber: item.pageNumber ?? null,
              createdBy: item.createdBy ?? null,
            },
          }),
        ),
      );

      return {
        aiKeyDateIds: [...kept.map((row) => row.id), ...created.map((row) => row.id)],
        deletedIds: staleIds,
      };
    });

    return { events: await this.list(caseId), aiKeyDateIds, deletedIds };
  }

  static async findById(id: string, caseId: string) {
    return prisma.caseTimelineEvent.findFirst({ where: { id, caseId } });
  }

  static async update(id: string, caseId: string, data: Partial<TimelineInput>) {
    const existing = await prisma.caseTimelineEvent.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseTimelineEvent.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseTimelineEvent.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
