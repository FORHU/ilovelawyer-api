import { FindingCategory, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import CaseFindingRepo, { AiFindingRow } from "../repositories/case-finding.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import WitnessRepo from "../repositories/witness.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { AI_FINDING_NOTE } from "../constants";
import type { ParsedCaseFinding } from "../utils/case-finding-parse";
import {
  CaseJevContext,
  formatClaim,
  formatContradiction,
  formatParty,
  formatTimelineEntry,
  formatWitness,
} from "../utils/case-jev-context";
import { BurdenParty, checkLegalIssueWithJev, isLegalIssueJevEnabled, tagFromCheck } from "../utils/legal-issue-jev";

// Jev's checks are stored as-is in CaseFinding.jev; the panel reads the per-category shape.
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Runs the per-category Jev checks for CaseFinding rows: over a freshly generated batch before
 * it's saved (verifyParsed), and on request for one row (checkOne). Legal Issues is the only
 * category with a check so far.
 */
export default class FindingJevSvc {
  /** The case data a finding is judged against — the same lists Red Team sends, plus claims.
   * `findings` supplies the Legal Issues / Weaknesses lists, so a batch still being generated
   * can be judged against itself rather than the rows it's about to replace. */
  static async loadContext(caseId: string, findings: { category: FindingCategory; label: string }[]): Promise<CaseJevContext> {
    const [parties, claims, timeline, contradictions, witnesses] = await Promise.all([
      prisma.party.findMany({ where: { caseId } }),
      CaseClaimRepo.list(caseId),
      CaseTimelineRepo.list(caseId),
      EvidenceRepo.listContradictions(caseId),
      WitnessRepo.list(caseId),
    ]);
    const labels = (category: FindingCategory) => findings.filter((f) => f.category === category).map((f) => f.label);
    return {
      opponent: null,
      parties: parties.map(formatParty),
      claims: claims.map(formatClaim),
      legalIssues: labels("LEGAL_ISSUE"),
      weaknesses: labels("WEAKNESS"),
      contradictions: contradictions.map(formatContradiction),
      timeline: timeline.map(formatTimelineEntry),
      witnesses: witnesses.map(formatWitness),
    };
  }

  /** A parsed batch as replaceAiFindings rows, positioned in the model's order within each
   * category, with Jev's tag replacing the model's on every row Jev checked (the model's kept as
   * modelTag). A failed check leaves that row on the model's tag with no jev. Never throws —
   * the findings must still save. */
  static async verifyParsed(caseId: string, parsed: ParsedCaseFinding[]): Promise<AiFindingRow[]> {
    const nextPosition = new Map<FindingCategory, number>();
    const rows: AiFindingRow[] = parsed.map((p) => {
      const position = nextPosition.get(p.category) ?? 0;
      nextPosition.set(p.category, position + 1);
      return { category: p.category, label: p.label, sourceLabel: p.sourceLabel, detail: p.detail, tag: p.tag, position };
    });
    if (!isLegalIssueJevEnabled() || !parsed.some((p) => p.category === "LEGAL_ISSUE")) return rows;

    let context: CaseJevContext;
    try {
      const manual = (await CaseFindingRepo.list(caseId)).filter((f) => f.notes !== AI_FINDING_NOTE);
      context = await FindingJevSvc.loadContext(caseId, [...manual, ...parsed]);
    } catch (err) {
      logger.warn("Finding Jev: couldn't load case context, saving the model's ratings", { err, caseId });
      return rows;
    }

    return Promise.all(
      rows.map(async (row, i): Promise<AiFindingRow> => {
        if (row.category !== "LEGAL_ISSUE") return row;
        try {
          const check = await checkLegalIssueWithJev(
            { label: row.label, detail: row.detail ?? null, sourceLabel: row.sourceLabel, modelBurden: parsed[i].burden },
            context,
          );
          return { ...row, tag: tagFromCheck(check), modelTag: row.tag ?? null, jev: asJson(check), jevCheckedAt: new Date() };
        } catch (err) {
          logger.warn("Finding Jev: check failed for one legal issue, keeping the model's rating", { err, label: row.label });
          return row;
        }
      }),
    );
  }

  /** Jev's check of one saved row, on the lawyer's request. Stores the check only — the row's
   * tag stays whatever the lawyer (or the last generation) set. */
  static async checkOne(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseFindingRepo.find(id, caseId);
    if (!row) throw new HttpError("Finding not found", 404);
    if (row.category !== "LEGAL_ISSUE") throw new HttpError("Jev can't check this kind of finding yet", 400);
    if (!isLegalIssueJevEnabled()) throw new HttpError("Jev checks for legal issues are turned off", 409);

    const others = (await CaseFindingRepo.list(caseId)).filter((f) => f.id !== id);
    const context = await FindingJevSvc.loadContext(caseId, others);
    // An AI row checked at generation keeps the model's burden call to compare against.
    const previous = row.jev as { modelBurden?: BurdenParty | null } | null;
    let check;
    try {
      check = await checkLegalIssueWithJev(
        { label: row.label, detail: row.detail, sourceLabel: row.sourceLabel, modelBurden: previous?.modelBurden ?? null },
        context,
      );
    } catch (err) {
      logger.warn("Finding Jev: on-demand check failed", { err, caseId, id });
      throw new HttpError("Jev couldn't check this finding. Try again.", 502);
    }
    const updated = await CaseFindingRepo.setJevCheck(id, asJson(check));
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.jevCheck", payload: { id } });
    return updated;
  }
}
