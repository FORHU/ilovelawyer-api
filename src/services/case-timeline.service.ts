import { TimelineSource } from "@prisma/client";
import CaseAccess from "../utils/case-access";
import CaseTimelineRepo, { TimelineInput } from "../repositories/case-timeline.repository";
import HttpError from "../utils/http-error";
import { TimelineItem } from "../utils/response-parser";
import OrganizationRepo from "../repositories/organization.repository";
import { ParsedKeyDate } from "../utils/case-strategy-parse";
import CaseGraphSvc from "./case-graph.service";

function parseOccurredOn(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

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
    return CaseTimelineRepo.createMany(caseId, incoming);
  }

  static async replaceDocumentDates(caseId: string, dates: ParsedKeyDate[], actorId?: string) {
    return CaseTimelineRepo.replaceAiKeyDates(
      caseId,
      dates.map((item) => ({
        title: item.title,
        occurredOn: new Date(`${item.date}T00:00:00Z`),
        createdBy: actorId ?? null,
      })),
    );
  }
}
