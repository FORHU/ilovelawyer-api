import CaseAccess from "../utils/case-access";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import CaseRiskRepo from "../repositories/case-risk.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import CitationCheckRepo from "../repositories/citation-check.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import OrganizationRepo from "../repositories/organization.repository";
import DocumentRepo from "../repositories/document.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import WitnessRepo from "../repositories/witness.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import RedTeamRepo from "../repositories/red-team.repository";
import DecisionRecordRepo from "../repositories/decision-record.repository";
import CaseTheoryRepo from "../repositories/case-theory.repository";
import AnnotationRepo from "../repositories/annotation.repository";
import CaseGraphRepo from "../repositories/case-graph.repository";
import ChatRepo from "../repositories/chat.repository";
import LawRepo from "../repositories/law.repository";
import CaseOutlookRepo from "../repositories/case-outlook.repository";
import prisma from "../lib/prisma";
import { scoreCaseRisks } from "../utils/case-risk-score";
import { isMindMapStale } from "../utils/mind-map-staleness";
import { buildCaseTrends } from "../utils/case-trends";
import { OutlookDriver } from "../utils/case-outlook-parse";
import { CASE_TREND_WEEKS, OUTLOOK_DISCLAIMER, OUTLOOK_HISTORY_LIMIT } from "../constants";

export default class CaseSnapshotSvc {
  static async get(caseId: string, userId: string) {
    const caseRecord = await CaseAccess.loadAccessibleCase(caseId, userId);

    const [
      documents,
      timeline,
      risks,
      events,
      evidenceMatrix,
      contradictions,
      citations,
      deadlines,
      procedureItems,
      accesses,
      audit,
      findings,
      witnesses,
      damages,
      reconstruction,
      redTeamAssessment,
      decisions,
      theories,
      annotations,
      staleness,
      requiredConfirmations,
      latestMindMap,
      outlook,
      outlookHistory,
    ] = await Promise.all([
      DocumentRepo.listAllByCase(caseId),
      CaseTimelineRepo.list(caseId),
      CaseRiskRepo.list(caseId),
      prisma.event.findMany({ where: { caseId }, orderBy: { dateTime: "asc" } }),
      EvidenceRepo.listMatrix(caseId),
      EvidenceRepo.listContradictions(caseId),
      CitationCheckRepo.list(caseId),
      ProceduralDeadlineRepo.list(caseId),
      ProceduralDeadlineRepo.listProcedureItems(caseId),
      OrganizationRepo.listCaseAccess(caseId),
      OrganizationRepo.listAudit(caseId),
      CaseFindingRepo.list(caseId),
      WitnessRepo.list(caseId),
      DamageClaimRepo.list(caseId),
      CaseReconstructionRepo.get(caseId),
      RedTeamRepo.get(caseId),
      DecisionRecordRepo.list(caseId),
      CaseTheoryRepo.list(caseId),
      AnnotationRepo.list(caseId),
      CaseGraphRepo.listStaleForCase(caseId),
      CaseAccess.requiredConfirmations(caseId),
      ChatRepo.findLatestMindMapCreatedAtForCase(caseId),
      CaseOutlookRepo.latest(caseId),
      CaseOutlookRepo.history(caseId, OUTLOOK_HISTORY_LIMIT),
    ]);

    const now = new Date();
    const nextEvent = events.find((event) => event.dateTime >= now) ?? events[0] ?? null;
    const nextTimeline = timeline.find((item) => item.occurredOn && item.occurredOn > now)
      ?? timeline.find((item) => item.occurredOn)
      ?? null;
    const nextDate = nextEvent ?? nextTimeline;
    const fatalRisks = risks.filter((r) => r.severity === "FATAL" && r.status === "OPEN");

    // Separate from citation validity (does the quote match the source): does the cited
    // authority itself exist? Same resolution engine Citation Map uses (resolvedLawId is
    // populated at check time by CitationCheckSvc, or lazily by CitationMapSvc.getSeed).
    // Decisions are grouped in the Terminal UI by the chat turn that produced them, not by any
    // category on the record itself (there isn't one — see DecisionRecord's schema comment).
    // sourceMessageId is the assistant reply; its parentMessageId is the actual user prompt, so
    // this is a two-hop lookup, batched to avoid an N+1 per decision.
    const assistantMessageIds = [...new Set(decisions.map((d) => d.sourceMessageId).filter((id): id is string => !!id))];
    const assistantMessages = await ChatRepo.findManyByIds(assistantMessageIds);
    const parentMessageIds = [...new Set(assistantMessages.map((m) => m.parentMessageId).filter((id): id is string => !!id))];
    const userMessages = await ChatRepo.findManyByIds(parentMessageIds);
    const userMessageById = new Map(userMessages.map((m) => [m.id, m]));
    const promptByAssistantMessageId = new Map(
      assistantMessages.map((m) => [m.id, m.parentMessageId ? (userMessageById.get(m.parentMessageId) ?? null) : null]),
    );
    const decisionsWithSourcePrompt = decisions.map((decision) => {
      const prompt = decision.sourceMessageId ? (promptByAssistantMessageId.get(decision.sourceMessageId) ?? null) : null;
      return {
        ...decision,
        sourcePrompt: prompt ? { messageId: prompt.id, consultationId: prompt.consultationId, content: prompt.content, createdAt: prompt.createdAt } : null,
      };
    });

    const resolvedLawIds = citations.map((c) => c.resolvedLawId).filter((id): id is string => !!id);
    const resolvedLaws = await LawRepo.findManyByIds(resolvedLawIds);
    const lawById = new Map(resolvedLaws.map((law) => [law.id, law]));
    const citationsWithAuthority = citations.map((citation) => {
      const law = citation.resolvedLawId ? lawById.get(citation.resolvedLawId) : undefined;
      return {
        ...citation,
        resolvedAuthority: law ? { lawId: law.id, title: law.title, jurisUrl: law.jurisUrl } : null,
      };
    });

    return {
      case: caseRecord,
      documents: documents.map((doc) => ({
        id: doc.id,
        name: doc.name,
        ragStatus: doc.ragStatus,
        documentType: doc.documentType,
        // The Workspace document browser's "folders" are purely this field (see
        // DocumentFolderBrowser on the frontend) — exposing it here is what lets the Legal
        // Terminal's Evidence & Timeline panel group the same document list into the same
        // folders instead of one flat list, without inventing a second folder concept.
        category: doc.category,
        mimeType: doc.mimeType,
        pageCount: doc.pageCount,
        extractionMethod: doc.extractionMethod,
        language: doc.language,
        createdAt: doc.createdAt,
        isExhibit: doc.isExhibit,
      })),
      timeline,
      risks,
      dates: events.map((event) => ({
        id: event.id,
        title: event.title,
        dateTime: event.dateTime,
        type: event.type,
        source: event.dateSource ?? "calendar",
        status: event.status,
      })),
      nextDate,
      fatalRisks,
      evidence: { matrix: evidenceMatrix, contradictions },
      law: { citations: citationsWithAuthority },
      procedure: { deadlines, items: procedureItems, requiredConfirmations },
      teamAudit: { accesses, audit },
      findings,
      witnesses,
      damages,
      reconstruction,
      redTeamAssessment,
      decisions: decisionsWithSourcePrompt,
      theories,
      annotations,
      staleness,
      mindMap: {
        lastGeneratedAt: latestMindMap?.createdAt ?? null,
        // Expanding/undoing on the map itself writes mindMap.* audit rows — those are the map
        // changing, not the case moving on without it, so they mustn't flag it stale.
        isStale: isMindMapStale(
          latestMindMap?.createdAt ?? null,
          audit.find((a) => !a.action.startsWith("mindMap."))?.createdAt ?? null,
        ),
      },
      // Band + confidence only — the outlook never carries a numeric probability. Null until the
      // case's first refresh after the outlook shipped (no backfill).
      outlook: outlook
        ? {
            id: outlook.id,
            band: outlook.band,
            confidence: outlook.confidence,
            rationale: outlook.rationale,
            drivers: outlook.drivers as unknown as OutlookDriver[],
            createdAt: outlook.createdAt,
            disclaimer: OUTLOOK_DISCLAIMER,
          }
        : null,
      outlookHistory,
      trends: buildCaseTrends({ risks, documents, weeks: CASE_TREND_WEEKS, now }),
      riskAnalysis: scoreCaseRisks({
        risks,
        contradictions,
        documents,
        citations,
        deadlines,
        matrix: evidenceMatrix,
      }),
      lastRefreshedAt: caseRecord.lastRefreshedAt,
    };
  }
}

export type CaseSnapshotResult = Awaited<ReturnType<typeof CaseSnapshotSvc.get>>;
