import crypto from "crypto";
import type { ClientWorkspace } from "./client-case.service";
import ClientIntakeRepo, { type ClientIntakeCaseSource } from "../repositories/client-intake.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import LlmUsageRepo from "../repositories/llm-usage.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";
import HttpError from "../utils/http-error";
import { isJobStale } from "../utils/ai-generation-lock.utils";
import { CLIENT_INTAKE_AI_BUDGET_USD, CLIENT_INTAKE_DAILY_CAP } from "../config";
import { CLIENT_STORY_MAX_LENGTH } from "../constants/client-case.constants";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { buildFactExcerptPack, wrapExtractedText } from "../utils/case-document-excerpts";
import { excerptsWithHandles } from "../utils/case-document-handles";
import { buildIntakePrompt, parseIntakeReply, caseDetailsPeople, deriveFormFields, hasStoryPlaceholderDetails, type IntakeMessageInput } from "../utils/client-intake-extract";
import { OTHER_CASE_AREA } from "../constants/case-area.constants";
import { openDocumentNote } from "../repositories/document-note.repository";
import type { CaseIntake, IntakeCompleteness, IntakeFormFields, IntakePerson } from "../types/client-intake";
import logger from "../utils/logger";
import CaseAreaSvc, { type CaseAreaRef } from "./case-area.service";

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 1500;

/** "story": a new client's story, or their fix to it (ClientStorySvc), read before any chat.
 * "questions": after the last of the Questions step (ClientQuestionsSvc), once over every answer.
 * "evidence": the evidence step's Done (ClientEvidenceSvc), once over the new proof and its notes. */
export type IntakeRefreshReason = "chat" | "document" | "case-details" | "manual" | "story" | "questions" | "evidence";

/**
 * The client app's Intake tab (docs/plans/client-side-compressed-meteor.md §3.1): one AI
 * extraction of the case, its chat and its READY documents into a traceable CaseIntake —
 * people, a timeline, facts, goals, concerns, questions for a lawyer, stated deadlines, missing
 * information and conflicts, each with its sources. Replaces ClientOverviewSvc's helps/mayHurt/
 * computed key dates, which were lawyer case-assessment content with no place in a secretary
 * app. The lawyer's Terminal pipeline (CaseStrategySvc, CaseFindingAiSvc) is untouched — nothing
 * here reads or writes it.
 *
 * Fingerprinted like ClientRequestBriefSvc's brief: unchanged case -> no AI call. Automatic
 * triggers (a chat reply finishing, a document going READY, an edit to the case details) never
 * count against the daily cap, only a client's own Update press does — both count against the
 * per-case AI budget.
 */
export default class ClientIntakeSvc {
  /** Manual Update (POST .../intake/refresh). Two quick presses return the same running job
   * rather than starting two, same idiom as ClientOverviewSvc.beginQueued. */
  static async beginQueued(workspace: ClientWorkspace, userId: string, caseId: string): Promise<CaseIntake> {
    await ClientIntakeSvc.assertOwned(workspace, caseId);

    const already = await AiGenerationLockSvc.getStatus(caseId, "clientIntake");
    if (already?.status === "IN_PROGRESS" && !isJobStale(already)) {
      return ClientIntakeSvc.get(workspace, caseId);
    }

    const spentUsd = await LlmUsageRepo.sumCostUsd(caseId);
    if (spentUsd >= CLIENT_INTAKE_AI_BUDGET_USD) {
      throw new HttpError("This case has reached its AI usage limit for the intake summary.", 402, "INTAKE_BUDGET_REACHED");
    }

    const claim = await ClientIntakeRepo.claimDailyRun(caseId, new Date(), CLIENT_INTAKE_DAILY_CAP);
    if (!claim) {
      throw new HttpError("You've reached today's limit for updating this case's intake summary.", 429, "INTAKE_DAILY_LIMIT", {
        nextUpdateAt: nextUtcMidnight().toISOString(),
      });
    }

    await ClientIntakeSvc.claimLock(caseId);
    const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
    AiGenerationQueue.enqueue({ kind: "clientIntake", caseId, userId });
    return ClientIntakeSvc.get(workspace, caseId);
  }

  private static async assertOwned(workspace: ClientWorkspace, caseId: string): Promise<void> {
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
  }

  /** The automatic triggers: after a chat reply finishes, after a document goes READY, or after
   * the case details change. Never throws — a guard that stops it here just means no run starts
   * now; the client can still press Update. Skips entirely when nothing's actually changed
   * (fingerprint match), so an idle case never spends AI budget on a no-op re-run. */
  static async scheduleAuto(caseId: string, userId: string, reason: IntakeRefreshReason): Promise<void> {
    try {
      const source = await ClientIntakeRepo.findCaseForIntake(caseId);
      if (!source) return;
      const { latestMessageId } = await ClientIntakeSvc.conversationOf(source);
      const fp = await fingerprintOf(source, latestMessageId);
      const stored = await ClientIntakeRepo.find(caseId);
      if (stored?.fingerprint === fp) return;

      const spentUsd = await LlmUsageRepo.sumCostUsd(caseId);
      if (spentUsd >= CLIENT_INTAKE_AI_BUDGET_USD) {
        logger.info("Client intake: automatic run skipped, case AI budget reached", { caseId, reason });
        return;
      }
      if (!(await ClientIntakeSvc.claimLock(caseId))) return;

      const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
      AiGenerationQueue.enqueue({ kind: "clientIntake", caseId, userId });
    } catch (err) {
      logger.error("Client intake: failed to schedule automatic run", { err, caseId, reason });
    }
  }

  private static async claimLock(caseId: string): Promise<boolean> {
    try {
      await AiGenerationLockSvc.begin(caseId, "clientIntake");
      return true;
    } catch (err) {
      // Already running — the run in flight will produce the current result either way.
      if (err instanceof HttpError && err.statusCode === 409) return false;
      throw err;
    }
  }

  /** Run by AiGenerationQueue's worker once beginQueued/scheduleAuto has claimed the lock. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "clientIntake", () => ClientIntakeSvc.generateInner(caseId, userId));
  }

  private static async generateInner(caseId: string, userId: string): Promise<void> {
    let source = await ClientIntakeRepo.findCaseForIntake(caseId);
    if (!source) return;

    const { messages, latestMessageId } = await ClientIntakeSvc.conversationOf(source);
    let fingerprint = await fingerprintOf(source, latestMessageId);
    const ready = source.documents.filter((d) => d.ragStatus === "READY").map((d) => ({ id: d.id, name: d.name }));

    // A case made from a story still has a title cut from it and the "Other" area: this run also
    // suggests real ones (from the site's own areas), applied below.
    const firstMessage = messages.find((m) => m.role === "user")?.text ?? null;
    const placeholder = hasStoryPlaceholderDetails({ title: source.caseName, caseAreaCodes: source.caseAreas }, firstMessage, OTHER_CASE_AREA);
    const suggestion = placeholder ? await ClientIntakeSvc.suggestionContext(userId) : null;

    // Captured once and reused for #157's formFields.typeOfAction below, so a case with several
    // areas isn't labelled twice for the one run.
    let caseAreaNames = (await CaseAreaSvc.refsOf(source.caseAreas)).map((a) => a.name);

    let parsed: ReturnType<typeof parseIntakeReply> = null;
    try {
      const pack = ready.length ? await buildFactExcerptPack(ready) : { text: "", chunkIds: [], factCount: 0 };
      const documentExcerpts = ready.length
        ? wrapExtractedText("Use only these excerpts and the documents listed above.", excerptsWithHandles(pack.text, ready))
        : "";
      const prompt = buildIntakePrompt({
        caseDetails: {
          title: source.caseName,
          caseAreas: caseAreaNames,
          ukJurisdiction: source.ukJurisdiction,
          outsideUk: source.outsideUk,
          where: source.jurisdiction,
          side: source.clientSide,
          notes: source.notes,
        },
        parties: source.parties,
        messages,
        documents: ready.map((d) => ({ ...d, note: openDocumentNote(source!.documents.find((x) => x.id === d.id)?.clientNote) })),
        documentExcerpts,
        today: ukDay(new Date()),
        suggestFrom: suggestion?.areas,
      });

      const session = await getChatWonderSessionId();
      const reply = await callChatWonderRest(prompt, session, undefined, "UK", {
        usage: { feature: "clientIntake", userId, caseId },
      });
      parsed = parseIntakeReply(
        String(reply.response ?? reply.intermediate_response ?? ""),
        ready,
        messages,
        suggestion?.areas.map((a) => a.code),
      );
    } catch (err) {
      logger.warn("Client intake: generation failed", { err, caseId });
    }

    if (!parsed) {
      // Nothing usable this run — keep whatever was there before rather than overwriting it with
      // less. The read side (get) reports FAILED when the fingerprint still doesn't match.
      throw new HttpError("The intake summary couldn't be generated this time", 502, "INTAKE_GENERATION_FAILED");
    }

    if (suggestion && (parsed.suggestedTitle || parsed.suggestedAreas.length)) {
      const applied = await ClientIntakeSvc.applySuggestion(suggestion.workspace, userId, caseId, parsed.suggestedTitle, parsed.suggestedAreas);
      // The title and areas are part of what the intake is built from: read the case again so the
      // result is saved as current (READY, not STALE) and its type of action shows the new areas.
      const updated = applied ? await ClientIntakeRepo.findCaseForIntake(caseId) : null;
      if (updated) {
        source = updated;
        fingerprint = await fingerprintOf(source, latestMessageId);
        caseAreaNames = (await CaseAreaSvc.refsOf(source.caseAreas)).map((a) => a.name);
      }
    }

    const people: IntakePerson[] = [
      ...caseDetailsPeople(source.parties).map((p) => ({
        id: crypto.createHash("sha1").update(`caseDetailsPerson:${p.name.toLowerCase()}`).digest("hex").slice(0, 16),
        name: p.name,
        role: p.role,
        text: p.role,
        sources: [{ kind: "CASE_DETAILS" as const, messageId: null, documentId: null, documentName: null, page: null }],
      })),
      ...parsed.people,
    ];

    const intake: CaseIntake = {
      generatedAt: new Date().toISOString(),
      status: "READY",
      updates: { allowed: true, leftToday: CLIENT_INTAKE_DAILY_CAP },
      summary: parsed.summary,
      people,
      timeline: parsed.timeline,
      facts: parsed.facts,
      goals: parsed.goals,
      concerns: parsed.concerns,
      questionsForLawyer: parsed.questionsForLawyer,
      deadlines: parsed.deadlines,
      missing: parsed.missing,
      conflicts: parsed.conflicts,
      storySoFar: parsed.storySoFar,
      completeness: completenessOf(source.lawyerReadiness),
      formFields: deriveFormFields({
        people,
        timeline: parsed.timeline,
        goals: parsed.goals,
        relationship: parsed.relationship,
        roleAndTerms: parsed.roleAndTerms,
        reasonGiven: parsed.reasonGiven,
        typeOfAction: caseAreaNames,
        venue: source.ukJurisdiction ?? source.jurisdiction ?? null,
      }),
    };

    await ClientIntakeRepo.saveResult(caseId, { data: intake, fingerprint });
  }

  /** What a story case's suggestion needs: the client's workspace (for its site and for the case
   * update) and the site's switched-on areas besides "Other", which is what the case already has.
   * Null when they can't be read: the run then goes ahead without suggesting anything. */
  private static async suggestionContext(userId: string): Promise<{ workspace: ClientWorkspace; areas: CaseAreaRef[] } | null> {
    try {
      // Imported here: client-case.service imports this service.
      const ClientCaseSvc = (await import("./client-case.service")).default;
      // The workspace exists already (the case is in it), so the name for making one is never used.
      const workspace = await ClientCaseSvc.workspaceFor(userId, "");
      const areas = (await CaseAreaSvc.listActive(workspace.tenantCode)).filter((a) => a.code !== OTHER_CASE_AREA);
      return areas.length ? { workspace, areas } : null;
    } catch (err) {
      logger.warn("Client intake: no case-area suggestion this run", { err, userId });
      return null;
    }
  }

  /** Puts the suggested title and areas on a story case, without starting another intake run
   * (this one saves its result right after). True when the case changed. A refusal (a lawyer
   * already holds the request, an area switched off meanwhile) only means the case keeps its
   * placeholders; the intake is saved all the same. */
  private static async applySuggestion(workspace: ClientWorkspace, userId: string, caseId: string, title: string | null, areas: string[]): Promise<boolean> {
    try {
      const ClientCaseSvc = (await import("./client-case.service")).default;
      await ClientCaseSvc.update(
        workspace,
        userId,
        caseId,
        { ...(title ? { title } : {}), ...(areas.length ? { areas } : {}) },
        { refreshIntake: false },
      );
      logger.info("Client intake: story case details suggested", { caseId, title: !!title, areas });
      return true;
    } catch (err) {
      logger.warn("Client intake: couldn't apply the suggested case details", { err, caseId });
      return false;
    }
  }

  /** The read side (GET .../intake). Never writes, queues or takes a lock. */
  static async get(workspace: ClientWorkspace, caseId: string): Promise<CaseIntake> {
    await ClientIntakeSvc.assertOwned(workspace, caseId);
    const [stored, job, source] = await Promise.all([
      ClientIntakeRepo.find(caseId),
      AiGenerationJobRepo.findBySubjectAndKind(caseId, "clientIntake"),
      ClientIntakeRepo.findCaseForIntake(caseId),
    ]);
    if (!source) throw new HttpError("Case not found", 404);

    const liveJob = job?.status === "IN_PROGRESS" && !isJobStale(job) ? job : null;
    const data = (stored?.data as unknown as CaseIntake | null) ?? null;
    const { latestMessageId } = await ClientIntakeSvc.conversationOf(source);
    const currentFp = await fingerprintOf(source, latestMessageId);
    const stale = !!data && stored?.fingerprint !== currentFp;
    const lastRunFailed = !liveJob && !!job && (job.status === "FAILED" || job.status === "IN_PROGRESS");

    const status: CaseIntake["status"] = liveJob ? "RUNNING" : data ? (stale ? "STALE" : "READY") : lastRunFailed ? "FAILED" : "EMPTY";

    if (!data) {
      // No AI run yet, but parties/typeOfAction/venue are the case-creation form's own data, so
      // they're real here too — only witnesses/timeline/clientGoals (AI-extracted) are empty.
      const caseAreaNames = (await CaseAreaSvc.refsOf(source.caseAreas)).map((a) => a.name);
      return {
        generatedAt: null,
        status,
        updates: { allowed: !liveJob, leftToday: Math.max(0, CLIENT_INTAKE_DAILY_CAP - ClientIntakeRepo.usedToday(stored)) },
        summary: null,
        people: [],
        timeline: [],
        facts: [],
        goals: [],
        concerns: [],
        questionsForLawyer: [],
        deadlines: [],
        missing: [],
        conflicts: [],
        storySoFar: [],
        completeness: completenessOf(source.lawyerReadiness),
        formFields: deriveFormFields({
          people: caseDetailsPeople(source.parties).map((p) => ({ id: "", name: p.name, role: p.role, text: p.role, sources: [] })),
          timeline: [],
          goals: [],
          relationship: [],
          roleAndTerms: [],
          reasonGiven: [],
          typeOfAction: caseAreaNames,
          venue: source.ukJurisdiction ?? source.jurisdiction ?? null,
        }),
      };
    }

    return {
      ...data,
      // An intake saved before story lines existed has none; the next run adds them.
      storySoFar: data.storySoFar ?? [],
      // Backward-compatible: an intake persisted before formFields existed, or before
      // relationship/roleAndTerms/reasonGiven were added to it, has no usable shape in its stored
      // JSON — this falls back to an all-missing shell rather than undefined fields, and self-heals
      // on the next regeneration (any chat reply, document going READY, or case-details edit).
      formFields:
        data.formFields && "relationship" in data.formFields
          ? data.formFields
          : deriveFormFields({ people: data.people, timeline: data.timeline, goals: data.goals, relationship: [], roleAndTerms: [], reasonGiven: [], typeOfAction: [], venue: null }),
      status,
      updates: { allowed: !liveJob, leftToday: Math.max(0, CLIENT_INTAKE_DAILY_CAP - ClientIntakeRepo.usedToday(stored)) },
      completeness: completenessOf(source.lawyerReadiness),
    };
  }

  /** The compact JSON handed to chat-wonder's intake persona as `intake_context` (behind
   * CLIENT_INTAKE_PERSONA, see docs/plans/intake-persona-contract.md): the current intake's
   * still-open questions, so the interviewer can ask the next useful thing instead of repeating
   * itself. caseId-scoped only, like generateInner — callers (ChatSvc) have already established
   * this is a client-workspace case before reaching here. Never throws: a failure just means the
   * turn goes out with no hint. */
  static async promptContext(caseId: string): Promise<string | undefined> {
    try {
      const [stored, source] = await Promise.all([ClientIntakeRepo.find(caseId), ClientIntakeRepo.findCaseForIntake(caseId)]);
      if (!source) return undefined;
      const data = (stored?.data as unknown as CaseIntake | null) ?? null;
      return JSON.stringify({
        caseDetails: {
          title: source.caseName,
          caseAreas: (await CaseAreaSvc.refsOf(source.caseAreas)).map((a) => a.name),
          ukJurisdiction: source.ukJurisdiction,
          outsideUk: source.outsideUk,
          where: source.jurisdiction,
          side: source.clientSide,
        },
        missing: data?.missing.map((m) => ({ question: m.question, why: m.why })) ?? [],
        conflicts: data?.conflicts.map((c) => ({ description: c.description })) ?? [],
        questionsForLawyer: data?.questionsForLawyer.map((q) => ({ text: q.text })) ?? [],
        unmetReadinessCriteria: completenessOf(source.lawyerReadiness)?.criteria.filter((c) => !c.met).map((c) => c.key) ?? [],
      });
    } catch (err) {
      logger.warn("Client intake: prompt context unavailable", { err, caseId });
      return undefined;
    }
  }

  private static async conversationOf(source: ClientIntakeCaseSource): Promise<{ messages: IntakeMessageInput[]; latestMessageId: string | null }> {
    const rows = (await IntakeChatRepo.listByCase(source.id)).filter((m) => m.role === "user" || m.role === "assistant");
    // The client's first message is where they tell what happened (a whole story, on the story-first
    // way in), so it's read in full; later turns are answers and are cut to MAX_MESSAGE_CHARS.
    const firstId = rows.find((m) => m.role === "user")?.id;
    const messages = rows.slice(-MAX_MESSAGES).map((m): IntakeMessageInput => ({
      id: m.id,
      role: m.role === "user" ? "user" : "ai",
      text: m.content.slice(0, m.id === firstId ? CLIENT_STORY_MAX_LENGTH : MAX_MESSAGE_CHARS),
      at: m.createdAt,
    }));
    return { messages, latestMessageId: rows.at(-1)?.id ?? null };
  }
}

function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/** A day as the client sees it, UK time (client-request-brief.service.ts's ukDay, duplicated: a
 * pure one-liner, not worth a shared import across the two services). */
function ukDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** What the intake is built from, besides bookkeeping fields that change on their own
 * (Case.updatedAt moves on every credit spent) — same idiom as briefFingerprint. Exported for
 * test/client-intake.spec.ts, which needs to compute the real value to test the skip-when-
 * unchanged path precisely rather than approximately. */
export async function fingerprintOf(source: ClientIntakeCaseSource, latestMessageId: string | null): Promise<string> {
  const basis = JSON.stringify([
    source.caseName,
    source.caseAreas,
    source.ukJurisdiction,
    source.jurisdiction,
    source.clientSide,
    source.notes,
    source.parties.map((p) => [p.name, p.designation]),
    // Only when set, so every fingerprint from before outsideUk (#973) still matches.
    ...(source.outsideUk ? ["outsideUk"] : []),
    source.documents.filter((d) => d.ragStatus === "READY").map((d) => d.id),
    latestMessageId,
    // The client's notes on their documents, only when there are any, so every fingerprint from
    // before notes existed still matches. A sealed value changes only when its note is saved again.
    ...(source.documents.some((d) => d.clientNote) ? [source.documents.map((d) => d.clientNote ?? "")] : []),
  ]);
  return crypto.createHash("sha256").update(basis).digest("hex");
}

/** Lawyer Readiness (lawyer-readiness-jev.ts), already computed and stored on the case by
 * ClientCaseSvc.lawyerReadiness — reused here rather than asking Jev again. Null when the check
 * is off or has never run. */
function completenessOf(stored: unknown): IntakeCompleteness | null {
  const r = stored as { enabled?: boolean; ready?: boolean; criteria?: { key: string; label: string; met: boolean }[] } | null;
  if (!r?.enabled || !r.criteria) return null;
  return { ready: !!r.ready, criteria: r.criteria.map((c) => ({ key: c.key, label: c.label, met: c.met })) };
}
