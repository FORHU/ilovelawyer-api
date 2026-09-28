import { FindingCategory, FindingTag, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import CaseFindingRepo, { AiFindingRow } from "../repositories/case-finding.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import WitnessRepo from "../repositories/witness.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
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
import * as LegalIssueJev from "../utils/legal-issue-jev";
import * as WeaknessJev from "../utils/weakness-jev";
import * as StrengthJev from "../utils/strength-jev";
import { embedText } from "../utils/embedding";

// Jev's checks are stored as-is in CaseFinding.jev; the panel reads the per-category shape.
const asJson = (value: unknown) => value as Prisma.InputJsonValue;

interface CheckTarget {
  caseId: string;
  label: string;
  detail: string | null;
  sourceLabel: string | null;
  /** Legal Issues: the drafting model's burden call, which Jev's is compared against. */
  modelBurden: LegalIssueJev.BurdenParty | null;
}

interface CheckResult {
  check: unknown;
  tag: FindingTag;
  /** Only for categories whose rows carry the ▲ impact number. */
  impact?: number;
}

/** One category's Jev check: its flag, the call, and (optionally) how checked rows are ordered. */
interface FindingChecker {
  enabled(): boolean;
  run(target: CheckTarget, context: CaseJevContext): Promise<CheckResult>;
  order?(a: unknown, b: unknown): number;
}

const CHECKERS: Partial<Record<FindingCategory, FindingChecker>> = {
  LEGAL_ISSUE: {
    enabled: LegalIssueJev.isLegalIssueJevEnabled,
    async run(target, context) {
      const check = await LegalIssueJev.checkLegalIssueWithJev(target, context);
      return { check, tag: LegalIssueJev.tagFromCheck(check) };
    },
  },
  WEAKNESS: {
    enabled: WeaknessJev.isWeaknessJevEnabled,
    async run(target, context) {
      const check = await WeaknessJev.checkWeaknessWithJev(target, context);
      return { check, tag: WeaknessJev.tagFromCheck(check), impact: WeaknessJev.impactFromCheck(check) };
    },
    // "Ordered by how early it will surface."
    order: (a, b) => WeaknessJev.compareBySurfacing(a as WeaknessJev.WeaknessJevCheck, b as WeaknessJev.WeaknessJevCheck),
  },
  STRENGTH: {
    enabled: StrengthJev.isStrengthJevEnabled,
    async run(target, context) {
      const passages = await FindingJevSvc.sourcePassages(target.caseId, target.label, target.sourceLabel);
      const check = await StrengthJev.checkStrengthWithJev({ ...target, passages }, context);
      return { check, tag: StrengthJev.tagFromCheck(check), impact: StrengthJev.impactFromCheck(check) };
    },
    // "The documents that do the most work."
    order: (a, b) => StrengthJev.compareByWeight(a as StrengthJev.StrengthJevCheck, b as StrengthJev.StrengthJevCheck),
  },
};

const MAX_SOURCE_PASSAGES = 3;
const MAX_PASSAGE_CHARS = 1200;

/** The context minus the row being judged — a finding can't be its own evidence. */
function withoutSelf(context: CaseJevContext, category: FindingCategory, label: string): CaseJevContext {
  const drop = (list: string[]) => {
    const i = list.indexOf(label);
    return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
  };
  if (category === "LEGAL_ISSUE") return { ...context, legalIssues: drop(context.legalIssues) };
  if (category === "WEAKNESS") return { ...context, weaknesses: drop(context.weaknesses) };
  return context;
}

/**
 * Runs the per-category Jev checks for CaseFinding rows: over a freshly generated batch before
 * it's saved (verifyParsed), and on request for one row (checkOne). Legal Issues, Weaknesses and
 * Strengths have a check (CHECKERS); Attack and Defense Strategies don't.
 */
export default class FindingJevSvc {
  /** The passages of the finding's cited document (matched by name, as the model cites it) that
   * best match the finding — so Jev can check the document says what the panel shows beside it.
   * [] when there's no cited document, it isn't indexed, or the lookup fails; the check then says
   * it judged against the case data alone. */
  static async sourcePassages(caseId: string, label: string, sourceLabel: string | null): Promise<string[]> {
    if (!sourceLabel) return [];
    try {
      const docs = await DocumentRepo.listAllByCase(caseId);
      const doc = docs.find((d) => d.name === sourceLabel && d.ragStatus === "READY");
      if (!doc) return [];
      const ids = await DocumentChunkRepo.findRelevantByDocument(doc.id, await embedText(label), MAX_SOURCE_PASSAGES);
      const chunks = await DocumentChunkRepo.findTextsByIds(ids);
      return chunks.map((c) => `${c.pageNumber ? `[p. ${c.pageNumber}] ` : ""}${c.chunkText.slice(0, MAX_PASSAGE_CHARS)}`);
    } catch (err) {
      logger.warn("Finding Jev: couldn't read the cited document's passages", { err, caseId, sourceLabel });
      return [];
    }
  }

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
   * category. On every row Jev checked, Jev's tag (and impact, where the category has one)
   * replaces the model's, the model's tag is kept as modelTag, and a category with an `order`
   * is re-positioned by it — unchecked rows after the checked ones, in the model's order. A
   * failed check leaves that row on the model's rating with no jev. Never throws — the findings
   * must still save. */
  static async verifyParsed(caseId: string, parsed: ParsedCaseFinding[]): Promise<AiFindingRow[]> {
    const nextPosition = new Map<FindingCategory, number>();
    const rows: AiFindingRow[] = parsed.map((p) => {
      const position = nextPosition.get(p.category) ?? 0;
      nextPosition.set(p.category, position + 1);
      return { category: p.category, label: p.label, sourceLabel: p.sourceLabel, detail: p.detail, tag: p.tag, position };
    });
    const active = new Set(parsed.map((p) => p.category).filter((c) => CHECKERS[c]?.enabled()));
    if (active.size === 0) return rows;

    let context: CaseJevContext;
    try {
      const manual = (await CaseFindingRepo.list(caseId)).filter((f) => f.notes !== AI_FINDING_NOTE);
      context = await FindingJevSvc.loadContext(caseId, [...manual, ...parsed]);
    } catch (err) {
      logger.warn("Finding Jev: couldn't load case context, saving the model's ratings", { err, caseId });
      return rows;
    }

    const checks: unknown[] = await Promise.all(
      rows.map(async (row, i) => {
        if (!active.has(row.category)) return null;
        try {
          const target = { caseId, label: row.label, detail: row.detail ?? null, sourceLabel: row.sourceLabel, modelBurden: parsed[i].burden };
          const result = await CHECKERS[row.category]!.run(target, withoutSelf(context, row.category, row.label));
          rows[i] = {
            ...row,
            tag: result.tag,
            modelTag: row.tag ?? null,
            ...(result.impact !== undefined ? { impact: result.impact } : {}),
            jev: asJson(result.check),
            jevCheckedAt: new Date(),
          };
          return result.check;
        } catch (err) {
          logger.warn("Finding Jev: check failed for one row, keeping the model's rating", { err, category: row.category, label: row.label });
          return null;
        }
      }),
    );

    for (const category of active) {
      const order = CHECKERS[category]!.order;
      if (!order) continue;
      const inCategory = rows.map((row, i) => ({ i, check: checks[i] })).filter(({ i }) => rows[i].category === category);
      const checked = inCategory.filter((x) => x.check).sort((a, b) => order(a.check, b.check));
      const unchecked = inCategory.filter((x) => !x.check);
      [...checked, ...unchecked].forEach(({ i }, position) => {
        rows[i] = { ...rows[i], position };
      });
    }
    return rows;
  }

  /** Jev's check of one saved row, on the lawyer's request. Stores the check (and the impact
   * number, which the lawyer never sets) — the row's tag and position stay whatever the lawyer
   * or the last generation set. */
  static async checkOne(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseFindingRepo.find(id, caseId);
    if (!row) throw new HttpError("Finding not found", 404);
    const checker = CHECKERS[row.category];
    if (!checker) throw new HttpError("Jev can't check this kind of finding yet", 400);
    if (!checker.enabled()) throw new HttpError("Jev checks for this kind of finding are turned off", 409);

    const others = (await CaseFindingRepo.list(caseId)).filter((f) => f.id !== id);
    const context = await FindingJevSvc.loadContext(caseId, others);
    // An AI legal issue checked at generation keeps the model's burden call to compare against.
    const previous = row.jev as { modelBurden?: LegalIssueJev.BurdenParty | null } | null;
    let result: CheckResult;
    try {
      result = await checker.run(
        { caseId, label: row.label, detail: row.detail, sourceLabel: row.sourceLabel, modelBurden: previous?.modelBurden ?? null },
        context,
      );
    } catch (err) {
      logger.warn("Finding Jev: on-demand check failed", { err, caseId, id });
      throw new HttpError("Jev couldn't check this finding. Try again.", 502);
    }
    const updated = await CaseFindingRepo.setJevCheck(id, asJson(result.check), result.impact);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.jevCheck", payload: { id } });
    return updated;
  }
}
