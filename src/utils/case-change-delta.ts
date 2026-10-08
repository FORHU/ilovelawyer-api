import { ConfidenceLevel, FindingCategory, FindingTag, OutlookBand } from "@prisma/client";
import { contradictionKey } from "./contradiction-key";
import { normalizeForMatch } from "./witness-extract-parse";
import { RedTeamArgument, RedTeamArguments } from "./red-team-arguments-parse";
import { ReconstructionClaim } from "./case-reconstruction-claims-parse";
import { OutlookDriver } from "./case-outlook-parse";
import { MindMapItem } from "./response-parser";
import {
  CASE_CHANGE_CREDIBILITY_THRESHOLD,
  CASE_CHANGE_MAX_LISTED,
  CASE_CHANGE_RISK_OF_LOSS_THRESHOLD,
} from "../constants/case-change.constants";
import {
  AttributionCounts,
  AudioOverviewDelta,
  CaseChangeDeltas,
  ContradictionRef,
  ContradictionsDelta,
  DamagesDelta,
  FindingCategoryDelta,
  FindingsDelta,
  MindMapDelta,
  OutlookDelta,
  OutlookDriverRef,
  PaneNotRun,
  PaneStatus,
  ReconstructionDelta,
  RedTeamDelta,
  StrategyDelta,
  TheoryDelta,
  WitnessesDelta,
} from "../types/case-change";

// Pure before/after comparisons for the analysis refresh's change summary (CaseRefreshSvc). Each
// takes what a pane said before the run and after it, and names what changed. "The same item"
// means what the rest of the code already means by it: contradictionKey for contradictions, the
// category + label key matchRegeneratedFindings uses for findings.

// Only contradictions can run to hundreds (the full-bundle scan); every other pane's lists are
// bounded by its own parser (8 red-team arguments, a handful of findings, gaps and drivers).
const cap = <T>(items: T[]) => items.slice(0, CASE_CHANGE_MAX_LISTED);
const statusFor = (changes: number): PaneStatus => (changes > 0 ? "changed" : "unchanged");

// ── Contradictions ─────────────────────────────────────────────────────────────

type ContradictionLike = Parameters<typeof contradictionKey>[0] & { status?: string | null };

function contradictionRef(row: ContradictionLike, docName: Map<string, string>): ContradictionRef {
  return {
    kind: row.kind,
    factKey: row.factKey,
    leftValue: row.leftValue,
    rightValue: row.rightValue,
    leftDocument: docName.get(row.leftDocumentId) ?? null,
    rightDocument: docName.get(row.rightDocumentId) ?? null,
  };
}

/** `previous` is the table before the scan rebuilt it; `next` is what the scan found. */
export function diffContradictions(
  previous: ContradictionLike[],
  next: ContradictionLike[],
  docName: Map<string, string>,
): ContradictionsDelta {
  const before = new Set(previous.map(contradictionKey));
  const after = new Set(next.map(contradictionKey));
  const added = next.filter((row) => !before.has(contradictionKey(row)));
  const dropped = previous.filter((row) => !after.has(contradictionKey(row)));
  return {
    status: statusFor(added.length + dropped.length),
    added: cap(added).map((row) => contradictionRef(row, docName)),
    addedCount: added.length,
    dropped: cap(dropped).map((row) => contradictionRef(row, docName)),
    droppedCount: dropped.length,
    carriedOver: next.length - added.length,
    droppedTriaged: dropped.filter((row) => row.status && row.status !== "OPEN").length,
  };
}

// ── Findings ───────────────────────────────────────────────────────────────────

interface FindingLike {
  category: FindingCategory;
  label: string;
  tag?: FindingTag | null;
  impact?: number | null;
}

const findingKey = (f: FindingLike) => `${f.category}\u0000${f.label.trim().toLowerCase()}`;

/** Every finding on the case before and after the findings step — lawyer-written and
 * lawyer-edited rows are the same on both sides, so only what the AI rewrote shows up. `only` is
 * the one category a panel's own Regenerate rewrote. */
export function diffFindings(before: FindingLike[], after: FindingLike[], only?: FindingCategory): FindingsDelta {
  const beforeByKey = new Map(before.map((f) => [findingKey(f), f]));
  const afterByKey = new Map(after.map((f) => [findingKey(f), f]));
  const byCategory: FindingsDelta["byCategory"] = {};
  const entry = (category: FindingCategory): FindingCategoryDelta =>
    (byCategory[category] ??= { added: [], removed: [], rerated: [] });
  let changes = 0;

  for (const [key, f] of afterByKey) {
    const prev = beforeByKey.get(key);
    if (!prev) {
      entry(f.category).added.push(f.label);
      changes++;
    } else if ((prev.tag ?? null) !== (f.tag ?? null) || (prev.impact ?? null) !== (f.impact ?? null)) {
      entry(f.category).rerated.push({
        label: f.label,
        from: { tag: prev.tag ?? null, impact: prev.impact ?? null },
        to: { tag: f.tag ?? null, impact: f.impact ?? null },
      });
      changes++;
    }
  }
  for (const [key, f] of beforeByKey) {
    if (!afterByKey.has(key)) {
      entry(f.category).removed.push(f.label);
      changes++;
    }
  }
  return { status: statusFor(changes), byCategory, ...(only ? { category: only } : {}) };
}

// ── Red Team ───────────────────────────────────────────────────────────────────

interface RedTeamLike {
  arguments: unknown;
}

function argumentsOf(row: RedTeamLike | null | undefined): RedTeamArguments | null {
  const value = row?.arguments as RedTeamArguments | null | undefined;
  return value && Array.isArray(value.arguments) ? value : null;
}

/** An assessment from before ranked arguments existed (arguments null) counts as no assessment:
 * every argument would otherwise read as "new". */
export function diffRedTeam(before: RedTeamLike | null, after: RedTeamLike | null): RedTeamDelta {
  const prev = argumentsOf(before);
  const next = argumentsOf(after);
  const riskOfLoss = { from: prev?.riskOfLoss ?? null, to: next?.riskOfLoss ?? null };
  if (!next) return { status: "unchanged", first: !prev, riskOfLoss, added: [], dropped: [], restrengthened: [] };
  // A first assessment: nothing to compare with, so it lists what it argues — shown, never counted.
  if (!prev) return { status: "changed", first: true, riskOfLoss, added: next.arguments.map((a) => a.title), dropped: [], restrengthened: [] };
  const key = (a: RedTeamArgument) => normalizeForMatch(a.title);
  const prevByKey = new Map(prev.arguments.map((a) => [key(a), a]));
  const nextByKey = new Map(next.arguments.map((a) => [key(a), a]));
  const added = next.arguments.filter((a) => !prevByKey.has(key(a))).map((a) => a.title);
  const dropped = prev.arguments.filter((a) => !nextByKey.has(key(a))).map((a) => a.title);
  const restrengthened = next.arguments.flatMap((a) => {
    const was = prevByKey.get(key(a));
    return was && was.strength !== a.strength ? [{ title: a.title, from: was.strength, to: a.strength }] : [];
  });
  const delta = { first: false, riskOfLoss, added, dropped, restrengthened };
  return { status: statusFor(redTeamChanges({ ...delta, status: "changed" })), ...delta };
}

// ── Case Reconstruction ────────────────────────────────────────────────────────

interface ReconstructionLike {
  gaps: string[];
  claims: unknown;
}

function attributionOf(row: ReconstructionLike | null): AttributionCounts | null {
  if (!row || !Array.isArray(row.claims)) return null;
  const counts: AttributionCounts = { GROUNDED: 0, INFERENCE: 0, UNSUPPORTED: 0 };
  for (const claim of row.claims as ReconstructionClaim[]) {
    if (claim && claim.category in counts) counts[claim.category]++;
  }
  return counts;
}

/** Rewriting the narrative itself doesn't count — the refresh rewrites an unedited narrative on
 * every run, so it would make "nothing changed" impossible. Gaps opening or closing do. */
export function diffReconstruction(
  before: ReconstructionLike | null,
  after: ReconstructionLike | null,
  outcome: ReconstructionDelta["outcome"],
): ReconstructionDelta {
  const norm = (gaps: string[] | undefined) => new Map((gaps ?? []).map((g) => [normalizeForMatch(g), g]));
  const prev = norm(before?.gaps);
  const next = norm(after?.gaps);
  // A first narrative has nothing to compare against: its gaps are listed as what it found (shown,
  // never counted — see countChanges), not as gaps new evidence opened.
  const gapsOpened = [...next].filter(([k]) => !before || !prev.has(k)).map(([, g]) => g);
  const gapsClosed = before ? [...prev].filter(([k]) => !next.has(k)).map(([, g]) => g) : [];
  const status: PaneStatus =
    outcome === "skipped-edited" ? "skipped" : !before && after ? "changed" : statusFor(gapsOpened.length + gapsClosed.length);
  return {
    status,
    outcome,
    gapsOpened,
    gapsClosed,
    attribution: { from: attributionOf(before), to: attributionOf(after) },
  };
}

// ── Case Outlook ───────────────────────────────────────────────────────────────

interface OutlookLike {
  id: string;
  band: OutlookBand;
  confidence: ConfidenceLevel;
  drivers: unknown;
}

function driversOf(row: OutlookLike | null): OutlookDriverRef[] {
  const drivers = (Array.isArray(row?.drivers) ? row!.drivers : []) as OutlookDriver[];
  return drivers.filter((d) => d && typeof d.label === "string").map((d) => ({ label: d.label, direction: d.direction }));
}

/** `after` is the outlook the step left current. The step only inserts a row when the model's
 * reply was usable, so the same row on both sides means this run changed nothing. */
export function diffOutlook(before: OutlookLike | null, after: OutlookLike | null): OutlookDelta {
  const band = { from: before?.band ?? null, to: after?.band ?? null };
  const confidence = { from: before?.confidence ?? null, to: after?.confidence ?? null };
  const unchanged = { status: "unchanged" as const, first: !before, band, confidence, driversAdded: [], driversDropped: [] };
  if (!after || after.id === before?.id) return unchanged;
  // A first outlook: nothing to compare with, so it lists its factors — shown, never counted.
  if (!before) return { ...unchanged, status: "changed", first: true, driversAdded: driversOf(after) };
  const key = (d: OutlookDriverRef) => `${d.direction}\u0000${normalizeForMatch(d.label)}`;
  const prev = driversOf(before);
  const next = driversOf(after);
  const prevKeys = new Set(prev.map(key));
  const nextKeys = new Set(next.map(key));
  const delta = {
    first: false,
    band,
    confidence,
    driversAdded: next.filter((d) => !prevKeys.has(key(d))),
    driversDropped: prev.filter((d) => !nextKeys.has(key(d))),
  };
  return { status: statusFor(outlookChanges({ ...delta, status: "changed" })), ...delta };
}

// ── Shared ─────────────────────────────────────────────────────────────────────

/** Items on one side only, matched by `key`; each reported by `name`. */
function addedRemoved<T, N>(before: T[], after: T[], key: (item: T) => string, name: (item: T) => N) {
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((item) => !beforeKeys.has(key(item))).map(name),
    removed: before.filter((item) => !afterKeys.has(key(item))).map(name),
  };
}

// ── Case Strategy ──────────────────────────────────────────────────────────────

interface ProcedureItemLike {
  kind: string;
  label: string;
}
interface TimelineEventLike {
  title: string;
  occurredOn: Date | null;
  source?: string | null;
}
export interface StrategyLike {
  items: ProcedureItemLike[];
  dates: TimelineEventLike[];
}

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** The plan (STRATEGY items), to-dos (TODO items) and key dates the case-strategy step writes.
 * Lawyer-written items and dates are the same on both sides, so only what the AI rewrote shows. */
export function diffStrategy(before: StrategyLike | null, after: StrategyLike | null): StrategyDelta {
  const items = (side: StrategyLike | null, kind: string) => (side?.items ?? []).filter((i) => i.kind === kind);
  const label = (i: ProcedureItemLike) => normalizeForMatch(i.label);
  const plan = addedRemoved(items(before, "STRATEGY"), items(after, "STRATEGY"), label, (i) => i.label);
  const todos = addedRemoved(items(before, "TODO"), items(after, "TODO"), label, (i) => i.label);
  const dateKey = (d: TimelineEventLike) => `${normalizeForMatch(d.title)}\u0000${dayOf(d.occurredOn)}`;
  const dateRef = (d: TimelineEventLike) => ({ title: d.title, occurredOn: dayOf(d.occurredOn) });
  const dates = addedRemoved(before?.dates ?? [], after?.dates ?? [], dateKey, dateRef);
  const delta = {
    planAdded: plan.added,
    planRemoved: plan.removed,
    todosAdded: todos.added,
    todosRemoved: todos.removed,
    datesAdded: cap(dates.added),
    datesRemoved: cap(dates.removed),
  };
  return { status: statusFor(strategyChanges({ status: "changed", ...delta })), ...delta };
}

// ── Witnesses ──────────────────────────────────────────────────────────────────

interface WitnessLike {
  name: string;
  credibility: number;
  aiCredibility?: number | null;
  credibilityOverride?: number | null;
}

/** The score the Witnesses pane shows — see the Witness schema comment. */
const shownCredibility = (w: WitnessLike) => w.credibilityOverride ?? w.aiCredibility ?? w.credibility;

/** Witnesses before the run's witness steps (reading new documents, then scoring) and after both. */
export function diffWitnesses(before: WitnessLike[], after: WitnessLike[]): WitnessesDelta {
  const key = (w: WitnessLike) => normalizeForMatch(w.name);
  const { added, removed } = addedRemoved(before, after, key, (w) => w.name);
  const was = new Map(before.map((w) => [key(w), shownCredibility(w)]));
  const rescored = after.flatMap((w) => {
    const from = was.get(key(w));
    const to = shownCredibility(w);
    return from !== undefined && Math.abs(to - from) >= CASE_CHANGE_CREDIBILITY_THRESHOLD ? [{ name: w.name, from, to }] : [];
  });
  return { status: statusFor(added.length + removed.length + rescored.length), added, removed, rescored };
}

// ── Damages & Remedies ─────────────────────────────────────────────────────────

interface DamageLike {
  kind: string;
  title: string;
  amount: number | null;
}

/** Damages & Remedies entries before the run's damages steps and after them. AI entries are
 * proposals until a lawyer accepts them, so the claimed total itself only moves on acceptance —
 * the delta names entries and amounts, not the total. */
export function diffDamages(before: DamageLike[], after: DamageLike[]): DamagesDelta {
  const key = (d: DamageLike) => `${d.kind}\u0000${normalizeForMatch(d.title)}`;
  const { added, removed } = addedRemoved(before, after, key, (d) => d.title);
  const was = new Map(before.map((d) => [key(d), d.amount]));
  const amountChanged = after.flatMap((d) => {
    if (!was.has(key(d))) return [];
    const from = was.get(key(d)) ?? null;
    return from !== (d.amount ?? null) ? [{ title: d.title, from, to: d.amount ?? null }] : [];
  });
  return { status: statusFor(added.length + removed.length + amountChanged.length), added, removed, amountChanged };
}

// ── Theories (the AI draft) ────────────────────────────────────────────────────

interface TheoryLike {
  title: string;
  claims: { statement: string; stance: string }[];
  assumptions: { statement: string }[];
  openQuestions: { question: string }[];
}

/** The case's AI draft theory before the run and after. Lawyer theories and forks never change. */
export function diffTheory(before: TheoryLike | null, after: TheoryLike | null): TheoryDelta {
  const title = { from: before?.title ?? null, to: after?.title ?? null };
  const none = { first: !before, title, claimsAdded: [], claimsDropped: [], assumptionsChanged: 0, openQuestionsChanged: 0 };
  if (!after) return { status: "unchanged", ...none };
  // A first AI draft: nothing to compare with, so it lists its claims — shown, never counted.
  if (!before) return { status: "changed", ...none, claimsAdded: after.claims.map((c) => c.statement) };
  const claimKey = (c: { statement: string; stance: string }) => `${c.stance}\u0000${normalizeForMatch(c.statement)}`;
  const claims = addedRemoved(before.claims, after.claims, claimKey, (c) => c.statement);
  const changedCount = <T>(a: T[], b: T[], key: (item: T) => string) => {
    const r = addedRemoved(a, b, key, key);
    return r.added.length + r.removed.length;
  };
  const delta = {
    first: false,
    title,
    claimsAdded: claims.added,
    claimsDropped: claims.removed,
    assumptionsChanged: changedCount(before.assumptions, after.assumptions, (a) => normalizeForMatch(a.statement)),
    openQuestionsChanged: changedCount(before.openQuestions, after.openQuestions, (q) => normalizeForMatch(q.question)),
  };
  const anything = theoryChanges({ status: "changed", ...delta }) + delta.assumptionsChanged + delta.openQuestionsChanged;
  return { status: statusFor(anything), ...delta };
}

// ── Visual Strategy Map ────────────────────────────────────────────────────────

function pointLabels(root: MindMapItem | null | undefined): string[] {
  const out: string[] = [];
  const walk = (node: MindMapItem) => {
    for (const child of node.children ?? []) {
      out.push(normalizeForMatch(child.label ?? ""));
      walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

/** The case map's tree before the run and after. `keptUserChanges`: the build was skipped because
 * someone had expanded or edited the map, which the refresh never overwrites. */
export function diffMindMap(before: MindMapItem | null, after: MindMapItem | null, keptUserChanges: boolean): MindMapDelta {
  if (keptUserChanges) {
    return { status: "skipped", first: false, branchesAdded: [], branchesRemoved: [], pointsAdded: 0, pointsRemoved: 0, keptUserChanges: true };
  }
  const branches = (root: MindMapItem | null) => root?.children ?? [];
  // A first map has nothing to compare with: it lists its branches — shown, never counted.
  if (!before) {
    const built = branches(after).map((b) => b.label);
    return { status: after ? "changed" : "unchanged", first: true, branchesAdded: built, branchesRemoved: [], pointsAdded: 0, pointsRemoved: 0, keptUserChanges: false };
  }
  const branch = addedRemoved(branches(before), branches(after), (b) => normalizeForMatch(b.label ?? ""), (b) => b.label);
  const points = addedRemoved(pointLabels(before), pointLabels(after), (l) => l, (l) => l);
  const delta = {
    first: false,
    branchesAdded: branch.added,
    branchesRemoved: branch.removed,
    pointsAdded: points.added.length,
    pointsRemoved: points.removed.length,
    keptUserChanges: false,
  };
  const anything = delta.branchesAdded.length + delta.branchesRemoved.length + delta.pointsAdded + delta.pointsRemoved;
  return { status: statusFor(anything), ...delta };
}

// ── Audio Overview ─────────────────────────────────────────────────────────────

/** `overviewId`: the overview the step wrote, or null when it wrote none (no findings yet). */
export function audioOverviewDelta(overviewId: string | null | undefined): AudioOverviewDelta | PaneNotRun {
  return overviewId ? { status: "changed", overviewId } : { status: "skipped" };
}

// ── Counting ───────────────────────────────────────────────────────────────────

function strategyChanges(d: StrategyDelta): number {
  return d.planAdded.length + d.planRemoved.length + d.todosAdded.length + d.todosRemoved.length + d.datesAdded.length + d.datesRemoved.length;
}

function theoryChanges(d: TheoryDelta): number {
  if (d.first) return 0;
  // Assumptions and open questions are shown, not counted: the claims and the title are what the
  // theory argues.
  return d.claimsAdded.length + d.claimsDropped.length + (d.title.from !== d.title.to ? 1 : 0);
}

function redTeamChanges(d: RedTeamDelta): number {
  if (d.first) return 0;
  const { from, to } = d.riskOfLoss;
  const riskMoved = from !== null && to !== null && Math.abs(to - from) >= CASE_CHANGE_RISK_OF_LOSS_THRESHOLD;
  return d.added.length + d.dropped.length + d.restrengthened.length + (riskMoved ? 1 : 0);
}

function outlookChanges(d: OutlookDelta): number {
  if (d.first) return 0;
  const bandMoved = d.band.from !== null && d.band.to !== null && d.band.from !== d.band.to;
  // A confidence change alone is shown but not counted: the band is the outlook's verdict.
  return (bandMoved ? 1 : 0) + d.driversAdded.length + d.driversDropped.length;
}

/** The modal's headline number — one per item added, removed or re-rated, one per Red Team
 * risk-of-loss move past the threshold, one per outlook band move, one per map branch added or
 * removed. A pane that was skipped or failed counts nothing; a new Audio Overview never counts (one
 * is written every run). Mirrored in ilovelawyer-app's lib/terminal/change-summary.ts. */
export function countChanges(deltas: CaseChangeDeltas): number {
  const { contradictions, findings, redTeam, reconstruction, outlook, strategy, witnesses, damages, theory, mindMap } = deltas;
  let total = 0;
  if (ran(contradictions)) total += contradictions.addedCount + contradictions.droppedCount;
  if (ran(findings)) {
    for (const c of Object.values(findings.byCategory)) total += c.added.length + c.removed.length + c.rerated.length;
  }
  if (ran(redTeam)) total += redTeamChanges(redTeam);
  // A first narrative's gaps are what it found, not gaps new evidence opened.
  if (ran(reconstruction) && reconstruction.outcome !== "generated") total += reconstruction.gapsOpened.length + reconstruction.gapsClosed.length;
  if (ran(outlook)) total += outlookChanges(outlook);
  if (ran(strategy)) total += strategyChanges(strategy);
  if (ran(witnesses)) total += witnesses.added.length + witnesses.removed.length + witnesses.rescored.length;
  if (ran(damages)) total += damages.added.length + damages.removed.length + damages.amountChanged.length;
  if (ran(theory)) total += theoryChanges(theory);
  // Points moving below the branches are shown, not counted: a rebuild rewords many of them.
  if (ran(mindMap) && !mindMap.first) total += mindMap.branchesAdded.length + mindMap.branchesRemoved.length;
  return total;
}

/** A pane that was compared (changed or unchanged) — not skipped, failed or untracked. */
function ran<T extends { status: PaneStatus }>(delta: T | PaneNotRun | undefined): delta is T {
  return !!delta && (delta.status === "changed" || delta.status === "unchanged");
}
