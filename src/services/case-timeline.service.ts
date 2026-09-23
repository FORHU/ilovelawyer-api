import { TimelineSource } from "@prisma/client";
import CaseAccess from "../utils/case-access";
import CaseTimelineRepo, { TimelineInput } from "../repositories/case-timeline.repository";
import CaseRepo from "../repositories/case.repository";
import HttpError from "../utils/http-error";
import { TimelineItem } from "../utils/response-parser";
import OrganizationRepo from "../repositories/organization.repository";
import { ParsedKeyDate } from "../utils/case-strategy-parse";
import CaseGraphSvc from "./case-graph.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import { parseOccurredOn } from "../utils/case-timeline.utils";
import logger from "../utils/logger";

export default class CaseTimelineSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseTimelineRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: TimelineInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseTimelineRepo.create(caseId, { ...data, createdBy: data.createdBy ?? userId });
    await CaseGraphSvc.ensureNode(caseId, "TIMELINE_EVENT", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "timeline.create", payload: { id: row.id } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<TimelineInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseTimelineRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Timeline event not found", 404);
    if (data.occurredOn !== undefined || data.status !== undefined) {
      await CaseGraphSvc.markStale(caseId, "TIMELINE_EVENT", id, "Timeline event date/status changed");
    }
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseTimelineRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Timeline event not found", 404);
    // Otherwise CaseGraphViewSvc's "timeline" view — which reads CaseGraphNode, never
    // CaseTimelineEvent directly — keeps rendering this as a ghost "Untitled event" forever.
    await CaseGraphSvc.removeNode("TIMELINE_EVENT", id);
  }

  static async promoteFromAi(caseId: string, items: TimelineItem[], actorId?: string) {
    if (!caseId || items.length === 0) return { count: 0 };
    const existing = await CaseTimelineRepo.list(caseId);
    const existingKeys = new Set(existing.map((row) => `${row.title}|${row.occurredOn?.toISOString() ?? ""}`));
    const incoming: TimelineInput[] = items
      .map((item) => ({
        title: item.title,
        occurredOn: parseOccurredOn(item.date),
        description: item.description,
        status: item.status,
        source: "AI" as TimelineSource,
        createdBy: actorId ?? null,
      }))
      .filter((item) => !existingKeys.has(`${item.title}|${item.occurredOn?.toISOString() ?? ""}`));
    if (incoming.length === 0) return { count: 0 };
    // Individual creates (not CaseTimelineRepo.createMany) so each row's id is in hand to ensure
    // its CaseGraphNode — createMany can't return the rows it just inserted, and without a node
    // these are invisible to CaseGraphViewSvc's "timeline" view (see replaceDocumentDates above).
    const created = await Promise.all(incoming.map((item) => CaseTimelineRepo.create(caseId, item)));
    await Promise.all(created.map((row) => CaseGraphSvc.ensureNode(caseId, "TIMELINE_EVENT", row.id)));
    return { count: created.length };
  }

  /** `documentIds` is the full set of READY documents the run that produced `dates` actually
   * considered — see CaseTimelineRepo.replaceAiKeyDates for why that scopes what gets cleared.
   * A CaseTimelineEvent with no CaseGraphNode is invisible to CaseGraphViewSvc's "timeline" view
   * (it reads CaseGraphNode, never CaseTimelineEvent directly) — every surviving AI key-date row
   * gets its node (re-)ensured here, every call, not just newly-created ones, so a row that was
   * written before this bookkeeping existed still gets backfilled the next time this runs. */
  static async replaceDocumentDates(caseId: string, documentIds: string[], dates: ParsedKeyDate[], actorId?: string) {
    const { events, aiKeyDateIds, deletedIds } = await CaseTimelineRepo.replaceAiKeyDates(
      caseId,
      documentIds,
      dates.map((item) => ({
        title: item.title,
        occurredOn: new Date(`${item.date}T00:00:00Z`),
        documentId: item.documentId ?? null,
        pageNumber: item.pageNumber ?? null,
        createdBy: actorId ?? null,
      })),
    );
    await Promise.all(aiKeyDateIds.map((id) => CaseGraphSvc.ensureNode(caseId, "TIMELINE_EVENT", id)));
    await Promise.all(deletedIds.map((id) => CaseGraphSvc.removeNode("TIMELINE_EVENT", id)));
    return events;
  }

  /** Fast, synchronous half of a queued manual "Generate timeline" click — same beginQueued/
   * runQueued split every other Terminal Generate/Refresh action uses (see
   * CaseRefreshSvc.beginQueued). */
  static async beginQueuedGenerate(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "timelineGenerate");
  }

  /** Run by AiGenerationQueue's worker after beginQueuedGenerate has already claimed the job row.
   * Reuses CaseStrategySvc.generateFromDocuments — the same call the automatic post-extraction
   * pipeline runs — rather than a second, parallel "extract dates" implementation; that call also
   * still holds its own "caseStrategy" lock, so a manual click while an automatic refresh is
   * already extracting dates just waits for that run's result instead of erroring. */
  static async runQueuedGenerate(caseId: string, userId: string): Promise<void> {
    const startedAt = Date.now();
    logger.info("Timeline generate: job claimed", { caseId, userId });
    await AiGenerationLockSvc.finishWith(caseId, "timelineGenerate", async () => {
      if (!(await CaseRepo.exists(caseId))) return;
      const CaseStrategySvc = (await import("./case-strategy.service")).default;
      try {
        await CaseStrategySvc.generateFromDocuments(caseId, userId);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409) {
          logger.info("Timeline generate: case strategy already running, timeline reflects that run", {
            caseId,
            userId,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        throw err;
      }
      await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "timeline.generate", payload: {} });
    });
    logger.info("Timeline generate: job finished", { caseId, userId, durationMs: Date.now() - startedAt });
  }
}
