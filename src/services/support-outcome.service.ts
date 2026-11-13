import prisma from "../lib/prisma";
import SupportContentSvc from "./support-content.service";
import { redactBrief } from "../utils/brief-redaction";
import { SUPPORT_REPORT_TOP_UNMATCHED, SUPPORT_UNMATCHED_TEXT_MAX_LENGTH } from "../constants/support-ticket.constants";
import type { SupportOutcomeInput } from "../types/support-ticket";
import type { SupportContent } from "../types/support-content";

/** Typed text with emails, phone numbers and postcodes taken out, lower-cased and tidied, for the report. */
export function redactForReport(text: string): string {
  return redactBrief(text, { people: [], documentNames: [] }).toLowerCase().replace(/\s+/g, " ").trim().slice(0, SUPPORT_UNMATCHED_TEXT_MAX_LENGTH);
}

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

/**
 * How the Support Chat's flows are doing (EPIC ilovelawyer-client#120): each flow started, "Did that
 * help?" answered Yes or No, escalated to a person, and the typed text that matched nothing. Light on
 * purpose: counts and redacted phrases, no user, no transcript. Admins read it to fix the content.
 */
export default class SupportOutcomeSvc {
  static async record(events: SupportOutcomeInput[]): Promise<void> {
    const rows = events.flatMap((event) => {
      const text = event.kind === "UNMATCHED" && event.text ? redactForReport(event.text) : null;
      if (event.kind === "UNMATCHED" && !text) return [];
      return [{ kind: event.kind, flowId: event.flowId ?? null, contentVersion: event.contentVersion ?? null, text }];
    });
    if (rows.length > 0) await prisma.supportOutcome.createMany({ data: rows });
  }

  /** Counts for [from, to): per flow (worst first), the overall escalation rate, and the most typed phrases that matched nothing. */
  static async report(from: Date, to: Date) {
    const where = { createdAt: { gte: from, lt: to } };
    const [byFlow, unmatched, titles] = await Promise.all([
      prisma.supportOutcome.groupBy({ by: ["flowId", "kind"], where: { ...where, flowId: { not: null } }, _count: { _all: true } }),
      prisma.supportOutcome.groupBy({
        by: ["text"],
        where: { ...where, kind: "UNMATCHED", text: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { text: "desc" } },
        take: SUPPORT_REPORT_TOP_UNMATCHED,
      }),
      SupportOutcomeSvc.flowTitles(),
    ]);
    const totalsByKind = await prisma.supportOutcome.groupBy({ by: ["kind"], where, _count: { _all: true } });

    const flows = new Map<string, { started: number; helpedYes: number; helpedNo: number; escalated: number }>();
    for (const row of byFlow) {
      const flow = flows.get(row.flowId as string) ?? { started: 0, helpedYes: 0, helpedNo: 0, escalated: 0 };
      const n = row._count._all;
      if (row.kind === "FLOW_STARTED") flow.started += n;
      if (row.kind === "HELPED_YES") flow.helpedYes += n;
      if (row.kind === "HELPED_NO") flow.helpedNo += n;
      if (row.kind === "ESCALATED") flow.escalated += n;
      flows.set(row.flowId as string, flow);
    }
    const count = (kind: string) => totalsByKind.find((t) => t.kind === kind)?._count._all ?? 0;
    const started = count("FLOW_STARTED");

    return {
      from,
      to,
      totals: {
        started,
        helpedYes: count("HELPED_YES"),
        helpedNo: count("HELPED_NO"),
        escalated: count("ESCALATED"),
        unmatched: count("UNMATCHED"),
        escalationRate: rate(count("ESCALATED"), started),
      },
      flows: [...flows.entries()]
        .map(([flowId, f]) => ({
          flowId,
          flowTitle: titles.get(flowId) ?? null,
          ...f,
          helpedYesRate: rate(f.helpedYes, f.helpedYes + f.helpedNo),
          helpedNoRate: rate(f.helpedNo, f.helpedYes + f.helpedNo),
          escalationRate: rate(f.escalated, f.started),
        }))
        .sort((a, b) => b.escalated + b.helpedNo - (a.escalated + a.helpedNo) || b.started - a.started),
      unmatchedPhrases: unmatched.map((u) => ({ text: u.text as string, count: u._count._all })),
    };
  }

  /** Flow titles from the published content, so the report names a flow the admin recognises. */
  private static async flowTitles(): Promise<Map<string, string>> {
    const content = (await SupportContentSvc.latestVersion()).content as unknown as SupportContent;
    return new Map(Object.values(content.flows).map((flow) => [flow.id, flow.title]));
  }
}
