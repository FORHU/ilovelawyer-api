/**
 * The redacted shape of a CaseIntake a lawyer sees before claiming a request (ADR 0018, folded
 * into CaseBrief.intake by client-request-brief.service.ts). Pure and deterministic, same
 * guarantee as brief-redaction.ts's redactBrief: it never depends on the AI having written
 * nothing identifying, because `people`, source ids and document names are dropped structurally,
 * not matched out of free text.
 */
import { redactBrief, type RedactionContext } from "./brief-redaction";
import type { AnonymisedIntake, CaseIntake } from "../types/client-intake";

export function toAnonymisedIntake(intake: CaseIntake, ctx: RedactionContext): AnonymisedIntake {
  return {
    timeline: intake.timeline.map((t) => ({ id: t.id, date: t.date, datePrecision: t.datePrecision, text: redactBrief(t.text, ctx) })),
    goals: intake.goals.map((g) => ({ id: g.id, text: redactBrief(g.text, ctx) })),
    concerns: intake.concerns.map((c) => ({ id: c.id, text: redactBrief(c.text, ctx) })),
    questionsForLawyer: intake.questionsForLawyer.map((q) => ({ id: q.id, text: redactBrief(q.text, ctx) })),
    deadlines: intake.deadlines.map((d) => ({ id: d.id, date: d.date, text: redactBrief(d.text, ctx) })),
    missing: intake.missing.map((m) => ({ id: m.id, question: redactBrief(m.question, ctx), why: redactBrief(m.why, ctx) })),
    completeness: intake.completeness,
  };
}
