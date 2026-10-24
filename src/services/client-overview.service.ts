import type { ClientWorkspace } from "./client-case.service";
import ClientCaseOverviewSvc from "./client-case-overview.service";
import CaseChangeRun from "./case-change-run.service";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientOverviewRepo, { type ClientOverviewPanes } from "../repositories/client-overview.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import MissingEvidenceRepo from "../repositories/missing-evidence.repository";
import LlmUsageRepo from "../repositories/llm-usage.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseStrategySvc from "./case-strategy.service";
import CaseFindingAiSvc from "./case-finding-ai.service";
import MissingEvidenceAiSvc from "./missing-evidence-ai.service";
import HttpError from "../utils/http-error";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import { isJobStale } from "../utils/ai-generation-lock.utils";
import { CLIENT_OVERVIEW_AI_BUDGET_USD, CLIENT_OVERVIEW_DAILY_CAP } from "../config";
import type { CaseOverview, OverviewPane } from "../types/client-overview";
import logger from "../utils/logger";

const ALL_PANES: OverviewPane[] = ["strategy", "findings", "missingEvidence"];

/**
 * The write side of the client app's Overview tab (ilovelawyer-client#45 / ilovelawyer-api#572):
 * a job that runs only the panes a client needs — never the lawyer's full CaseRefreshSvc
 * pipeline. Lives in the client-shaped layer, next to ClientCaseSvc: no lawyer route reads this.
 * ClientCaseOverviewSvc is the read side (C1); beginQueued returns its DTO.
 *
 * The panes write the timeline (CaseStrategySvc → CaseTimelineEvent), "what to gather"
 * (CaseMissingEvidence) and "points that help/may hurt" (CaseFinding — STRENGTH/WEAKNESS only,
 * see case-finding-parse.ts). The summary is composed from those, deterministically (see
 * composeSummary) — not a separate AI call, so there's no new client-facing prose to send through
 * solicitor review (FORHU/ilovelawyer-app#846) beyond the fixed template strings here.
 */
export default class ClientOverviewSvc {
  /** Manual Generate/Update (POST .../overview/generate). Two quick requests return the same
   * running job rather than starting two. Refuses with 402/429 when the per-case AI budget (B7)
   * or today's cap (D1) is already used. */
  static async beginQueued(workspace: ClientWorkspace, userId: string, caseId: string): Promise<CaseOverview> {
    await ClientOverviewSvc.loadOwnedCase(caseId, workspace.id);

    const already = await AiGenerationLockSvc.getStatus(caseId, "clientOverview");
    if (already?.status === "IN_PROGRESS" && !isJobStale(already)) {
      return ClientCaseOverviewSvc.get(workspace, caseId);
    }

    const spentUsd = await LlmUsageRepo.sumCostUsd(caseId);
    if (spentUsd >= CLIENT_OVERVIEW_AI_BUDGET_USD) {
      throw new HttpError("This case has reached its AI usage limit for the overview.", 402, "OVERVIEW_BUDGET_REACHED");
    }

    const claim = await ClientOverviewRepo.claimDailyRun(caseId, new Date(), CLIENT_OVERVIEW_DAILY_CAP);
    if (!claim) {
      throw new HttpError("You've reached today's limit for updating this case's overview.", 429, "OVERVIEW_DAILY_LIMIT", {
        nextUpdateAt: nextUtcMidnight().toISOString(),
      });
    }

    try {
      await AiGenerationLockSvc.begin(caseId, "clientOverview");
    } catch (err) {
      // Lost the race to another request claiming the same run — nothing more to do, the job
      // that one started will produce today's result either way.
      if (!(err instanceof HttpError && err.statusCode === 409)) throw err;
    }

    const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
    AiGenerationQueue.enqueue({ kind: "clientOverview", caseId, userId });
    return ClientCaseOverviewSvc.get(workspace, caseId);
  }

  /** The automatic first-document trigger (case-post-extraction.ts's client-case branch), called
   * from inside that same AiGenerationQueue worker — so, like CaseRefreshSvc's own auto path, the
   * caller runs runQueued directly on a true result rather than enqueueing a second message.
   * Runs exactly once per case: once an overview has ever been generated, a later document only
   * marks it STALE (read live by `get`) and never re-runs AI by itself (C2's own acceptance
   * criterion) — only a client's own Update press (beginQueued) regenerates it after that. Never
   * throws: a guard that stops it here just means no run starts now, and the client can still
   * press Update by hand. */
  static async beginAuto(caseId: string): Promise<boolean> {
    const stored = await ClientOverviewRepo.find(caseId);
    if (stored?.generatedAt) return false;

    const spentUsd = await LlmUsageRepo.sumCostUsd(caseId);
    if (spentUsd >= CLIENT_OVERVIEW_AI_BUDGET_USD) {
      logger.info("Client overview: automatic run skipped, case AI budget reached", { caseId });
      return false;
    }
    const claim = await ClientOverviewRepo.claimDailyRun(caseId, new Date(), CLIENT_OVERVIEW_DAILY_CAP);
    if (!claim) {
      logger.info("Client overview: automatic run skipped, today's cap already used", { caseId });
      return false;
    }
    try {
      await AiGenerationLockSvc.begin(caseId, "clientOverview");
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) return false;
      throw err;
    }
    return true;
  }

  /** Run by AiGenerationQueue's worker after beginQueued/beginAuto already claimed the job row.
   * `reason` is what the run's change summary records: a client's own press, or the automatic
   * first-document run. */
  static async runQueued(caseId: string, userId: string, reason: "manual" | "post-extraction" = "manual"): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "clientOverview", () => ClientOverviewSvc.generateInner(caseId, userId, reason));
  }

  private static async generateInner(caseId: string, userId: string, reason: "manual" | "post-extraction"): Promise<void> {
    const docs = await DocumentRepo.listAllByCase(caseId);
    const readyIds = docs.filter((d) => d.ragStatus === "READY").map((d) => d.id);

    // Each pane reports itself the moment it settles — written to the job's own `stage` (a
    // comma list, same idiom as CaseRefreshSvc's CASE_REFRESH_STAGE) so a GET while this run is
    // still IN_PROGRESS can show real progress (RunningBanner) instead of a bare spinner.
    const panes: ClientOverviewPanes = {};
    // Records which tracked panes failed or were skipped; missing evidence isn't a change-tracked
    // pane (CaseChangeDeltas), so it runs untracked.
    const changes = new CaseChangeRun(caseId);
    const settled = async (pane: OverviewPane, run: Promise<unknown>) => {
      try {
        await run;
        panes[pane] = "DONE";
      } catch (err) {
        // A pane's own lock already held elsewhere (409) reads the same as a real failure here —
        // this run didn't refresh it, so the client sees yesterday's content for that section,
        // same as any other failure.
        panes[pane] = "FAILED";
        logger.warn("Client overview: pane failed", { err, caseId, pane });
      }
      await AiGenerationLockSvc.setStage(caseId, "clientOverview", ALL_PANES.filter((p) => panes[p]).join(","));
    };

    await Promise.all([
      settled("strategy", changes.track("strategy", () => CaseStrategySvc.generateFromDocuments(caseId, userId))),
      settled("findings", changes.track("findings", () => CaseFindingAiSvc.generateFromDocuments(caseId, userId))),
      settled("missingEvidence", MissingEvidenceAiSvc.generateFromDocuments(caseId, userId)),
    ]);

    if (Object.values(panes).every((p) => p === "FAILED")) {
      throw new HttpError("Every part of the overview failed to generate", 502, "OVERVIEW_GENERATION_FAILED");
    }

    const [timeline, findings, missing] = await Promise.all([
      CaseTimelineRepo.list(caseId),
      CaseFindingRepo.list(caseId),
      MissingEvidenceRepo.list(caseId),
    ]);
    const helps = findings.filter((f) => f.category === "STRENGTH");
    const hurts = findings.filter((f) => f.category === "WEAKNESS");
    const toGather = missing.filter((m) => m.status === "OPEN");

    await ClientOverviewRepo.saveResult(caseId, {
      summary: composeSummary({ timelineCount: timeline.length, helpsCount: helps.length, hurtsCount: hurts.length, toGatherCount: toGather.length }),
      panes,
      readySetFingerprint: computeReadySetFingerprint(docs),
      documentIds: readyIds,
    });
    // After the content, so ClientCaseOverviewSvc can tell this run's summary (created at or after
    // generatedAt) from an older one when this save fails. Never throws.
    await changes.save({ reason, actorId: userId, documents: docs });
  }

  private static async loadOwnedCase(caseId: string, organizationId: string) {
    const row = await ClientCaseRepo.findById(caseId, organizationId);
    if (!row) throw new HttpError("Case not found", 404);
    return row;
  }
}

function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/** Deterministic, not AI-authored: see the class comment on why. Three short sentences, the way
 * the FE mockup shows it — real wording goes to solicitor review (FORHU/ilovelawyer-app#846)
 * before release; this template is a placeholder shape, not final client-facing copy. */
function composeSummary(counts: { timelineCount: number; helpsCount: number; hurtsCount: number; toGatherCount: number }): string {
  const parts: string[] = [];
  parts.push(
    counts.timelineCount > 0
      ? `Your documents establish ${counts.timelineCount} ${counts.timelineCount === 1 ? "event" : "events"} so far.`
      : "Your documents don't establish any dated events yet.",
  );
  if (counts.helpsCount || counts.hurtsCount) {
    parts.push(`${counts.helpsCount} point${counts.helpsCount === 1 ? "" : "s"} help your case, and ${counts.hurtsCount} may not.`);
  }
  if (counts.toGatherCount > 0) {
    parts.push(`There ${counts.toGatherCount === 1 ? "is" : "are"} ${counts.toGatherCount} thing${counts.toGatherCount === 1 ? "" : "s"} worth gathering to strengthen it.`);
  }
  return parts.join(" ");
}
