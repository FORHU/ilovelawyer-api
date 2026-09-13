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
import prisma from "../lib/prisma";
import { scoreCaseRisks } from "../utils/case-risk-score";
import { isMindMapStale } from "../utils/mind-map-staleness";

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
        mimeType: doc.mimeType,
        pageCount: doc.pageCount,
        extractionMethod: doc.extractionMethod,
        language: doc.language,
        createdAt: doc.createdAt,
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
      decisions,
      theories,
      annotations,
      staleness,
      mindMap: {
        lastGeneratedAt: latestMindMap?.createdAt ?? null,
        isStale: isMindMapStale(latestMindMap?.createdAt ?? null, audit[0]?.createdAt ?? null),
      },
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
