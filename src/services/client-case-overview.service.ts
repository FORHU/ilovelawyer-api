import type { ClientWorkspace } from "./client-case.service";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientOverviewRepo, { type ClientOverviewPanes } from "../repositories/client-overview.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import MissingEvidenceRepo from "../repositories/missing-evidence.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseChangeSummaryRepo from "../repositories/case-change-summary.repository";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";
import HttpError from "../utils/http-error";
import { computeReadySetFingerprint, diffDocumentIds, mindMapDocumentIds } from "../utils/ready-set-fingerprint";
import { isJobStale } from "../utils/ai-generation-lock.utils";
import { sectionStatus } from "../utils/client-overview-status";
import { CLIENT_OVERVIEW_DAILY_CAP } from "../config";
import type { CaseOverview, OverviewPane, OverviewPoint } from "../types/client-overview";

const ALL_PANES: OverviewPane[] = ["strategy", "findings", "missingEvidence"];

/**
 * The read side of the client app's Overview tab (ilovelawyer-api#571, C1): one whitelisted DTO,
 * read straight from the repositories. Never CaseSnapshotSvc — that returns every Terminal panel
 * and schedules AI as a side effect. Nothing here writes, queues or takes a lock;
 * test/client-case-overview.spec.ts scans this file's imports to keep it that way.
 * ClientOverviewSvc is the write side (the generate job) and returns this same DTO.
 *
 * Every field is mapped from an allowlist, never spread from a row: findings are STRENGTH and
 * WEAKNESS only, missing evidence is OPEN items only (resolving or dismissing one is a lawyer's
 * triage), and keyDates are left out entirely for a case outside the UK (D5).
 */
export default class ClientCaseOverviewSvc {
  static async get(workspace: ClientWorkspace, caseId: string): Promise<CaseOverview> {
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    // A client who says the case is outside the UK has no UK jurisdiction set (ClientCaseSvc).
    const inUk = row.ukJurisdiction !== null;

    const [stored, job, docs, timeline, findings, missing, deadlines, lastChange] = await Promise.all([
      ClientOverviewRepo.find(caseId),
      AiGenerationJobRepo.findBySubjectAndKind(caseId, "clientOverview"),
      DocumentRepo.listAllByCase(caseId),
      CaseTimelineRepo.list(caseId),
      CaseFindingRepo.list(caseId),
      MissingEvidenceRepo.list(caseId),
      inUk ? ProceduralDeadlineRepo.list(caseId) : Promise.resolve([]),
      CaseChangeSummaryRepo.latestRefresh(caseId),
    ]);

    const liveJob = job?.status === "IN_PROGRESS" && !isJobStale(job) ? job : null;
    const runningPanesDone = liveJob ? ALL_PANES.filter((p) => (liveJob.stage ?? "").split(",").includes(p)) : null;
    const generatedAt = stored?.generatedAt ?? null;
    const stale = !!generatedAt && stored!.readySetFingerprint !== computeReadySetFingerprint(docs);
    const generated = generatedAt ? { panes: (stored!.panes ?? {}) as ClientOverviewPanes, stale } : null;
    const lastRunFailed = !liveJob && !!job && (job.status === "FAILED" || job.status === "IN_PROGRESS");
    const status = (pane: OverviewPane, hasContent: boolean) => sectionStatus({ pane, runningPanesDone, generated, lastRunFailed, hasContent });

    // Count against the change summary the last run saved (ClientOverviewSvc.generateInner saves
    // it right after the content) — or, when that summary didn't save or predates the run, the
    // document ids the run stored with its content.
    const runSummary = generatedAt && lastChange && lastChange.createdAt >= generatedAt ? lastChange : null;
    const change = !stale
      ? null
      : runSummary
        ? diffDocumentIds(runSummary.readyDocumentIds, mindMapDocumentIds(docs))
        : diffDocumentIds(stored!.documentIds, docs.filter((d) => d.ragStatus === "READY").map((d) => d.id));

    const names = new Map(row.documents.map((d) => [d.id, d.name]));
    const helps = findings.filter((f) => f.category === "STRENGTH").map(toPoint);
    const mayHurt = findings.filter((f) => f.category === "WEAKNESS").map(toPoint);
    const toGather = missing.filter((m) => m.status === "OPEN");
    const summary = stored?.summary ?? null;

    return {
      generatedAt: generatedAt ? generatedAt.toISOString() : null,
      job: liveJob ? { startedAt: liveJob.startedAt.toISOString(), panesDone: runningPanesDone! } : null,
      changedSince: change ? { added: change.added.length, removed: change.removed.length } : null,
      updates: { allowed: !liveJob, leftToday: Math.max(0, CLIENT_OVERVIEW_DAILY_CAP - usedToday(stored)) },
      sections: {
        summary: status("strategy", !!summary),
        timeline: status("strategy", timeline.length > 0),
        ...(inUk ? { keyDates: deadlines.length > 0 ? ("READY" as const) : ("EMPTY" as const) } : {}),
        toGather: status("missingEvidence", toGather.length > 0),
        helps: status("findings", helps.length > 0),
        mayHurt: status("findings", mayHurt.length > 0),
      },
      summary,
      timeline: timeline.map((t) => {
        const name = t.documentId ? names.get(t.documentId) : undefined;
        return {
          id: t.id,
          date: t.occurredOn ? t.occurredOn.toISOString() : null,
          label: t.title,
          sourceDocumentId: name !== undefined ? t.documentId : null,
          sourceDocumentName: name ?? null,
        };
      }),
      ...(inUk
        ? {
            keyDates: deadlines.map((d) => ({
              id: d.id,
              label: d.label,
              date: d.computedDueDate.toISOString(),
              status: d.confirmations.some((c) => c.confirmed) ? ("CONFIRMED" as const) : ("ESTIMATED" as const),
            })),
          }
        : {}),
      toGather: toGather.map((g) => ({ id: g.id, title: g.label, why: g.detail ?? "" })),
      helps,
      mayHurt,
    };
  }
}

function toPoint(f: { id: string; label: string; detail: string | null }): OverviewPoint {
  return { id: f.id, title: f.label, detail: f.detail };
}

function usedToday(stored: { runDay: Date | null; runsOnDay: number } | null): number {
  return stored?.runDay && isSameUtcDate(stored.runDay, new Date()) ? stored.runsOnDay : 0;
}

function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
