import crypto from "crypto";
import path from "path";
import { ConsultationStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { copyS3Object, s3UrlForKey } from "../utils/s3";
import DocumentExtractionQueue from "../queues/document-extraction.queue";

/** Thrown for a copy that can never succeed (e.g. the original is gone) — not retried. */
export class CaseCopyAbandoned extends Error {}

type CopyRequest = { sourceCaseId: string; userId: string; targetOrganizationId: string; sourceOrganizationName: string };
type ConsultationCopyRequest = { sourceConsultationId: string; userId: string; targetOrganizationId: string };

const CONSULTATION_INCLUDE = {
  messages: true,
  messageGroups: true,
  documents: { include: { file: true } },
} satisfies Prisma.ConsultationInclude;

type SourceConsultation = Prisma.ConsultationGetPayload<{ include: typeof CONSULTATION_INCLUDE }>;
type SourceDocument = SourceConsultation["documents"][number];

/** New ids for everything copied, made up front so cross-references can be rewritten. */
type IdMaps = {
  consultations: Map<string, string>;
  groups: Map<string, string>;
  messages: Map<string, string>;
  documents: Map<string, string>;
  files: Map<string, string>;
};

/** Where the copy lands. `caseId` is the copied case (null for a standalone consultation), and
 * `sourceCaseId` the original it was copied from — only documents on that case keep a case link. */
type Target = { userId: string; organizationId: string; caseId: string | null; sourceCaseId: string | null };

const mapped = <T>(ids: Map<string, string>, id: T | null) => (id ? (ids.get(id as string) ?? null) : null);

/**
 * Makes a creator's portfolio copy of a case they created in an organization they've left
 * (queued by OrganizationSvc, worked through by CaseCopyQueue). The original stays with the
 * organization untouched; the copy is fully independent from then on.
 *
 * Copied: the case and its parties, notes, timeline, calendar events, documents (files copied in
 * S3, not shared), and consultations with their messages. Not copied: AI analysis — the copied
 * documents are re-indexed, which regenerates it the same way a fresh upload does — and anything
 * tied to the old organization's people (access grants, views, audit history, terminal layouts).
 * Every copied party, document, consultation, event and timeline entry records the original item
 * it came from (copiedFromId), for comparing the copy with its original later.
 *
 * copyConsultation does the same for a standalone consultation (one not on a case) its starter
 * leaves behind.
 */
export default class CaseCopySvc {
  /** Overridable in tests, which have no S3. */
  static copyObject: (sourceKey: string, destinationKey: string) => Promise<void> = copyS3Object;

  /** Returns the copy's case id. Reuses a copy already made since the original last changed, so a
   * retried job — or leaving, rejoining and leaving again without changes — doesn't duplicate it. */
  static async copy(request: CopyRequest): Promise<string> {
    const source = await prisma.case.findUnique({
      where: { id: request.sourceCaseId },
      include: {
        parties: true,
        timelineEvents: true,
        events: true,
        documents: { include: { file: true } },
        consultations: { where: { status: { not: ConsultationStatus.FOR_DELETION } }, include: CONSULTATION_INCLUDE },
      },
    });
    if (!source) throw new CaseCopyAbandoned("The original case was deleted before it could be copied");

    const existing = await prisma.case.findFirst({
      where: { copiedFromCaseId: source.id, organizationId: request.targetOrganizationId, copiedAt: { gte: source.updatedAt } },
      select: { id: true },
    });
    if (existing) return existing.id;

    const caseId = crypto.randomUUID();
    const target: Target = { userId: request.userId, organizationId: request.targetOrganizationId, caseId, sourceCaseId: source.id };
    const { ids, documents, files } = await CaseCopySvc.prepare(
      source.consultations,
      source.documents,
      (fileId, ext) => `documents/cases/${caseId}/${Date.now()}-${fileId.slice(0, 8)}${ext}`,
    );

    await prisma.$transaction(
      async (tx) => {
        await tx.case.create({
          data: {
            id: caseId,
            userId: request.userId,
            createdByName: source.createdByName,
            organizationId: request.targetOrganizationId,
            caseName: source.caseName,
            actionType: source.actionType,
            jurisdiction: source.jurisdiction,
            ukJurisdiction: source.ukJurisdiction,
            language: source.language,
            notes: source.notes,
            status: source.status,
            clientSide: source.clientSide,
            copiedFromCaseId: source.id,
            copiedFromOrgName: request.sourceOrganizationName,
            copiedAt: new Date(),
          },
        });

        if (source.parties.length) {
          await tx.party.createMany({
            data: source.parties.map((p) => ({
              caseId,
              copiedFromId: p.id,
              name: p.name,
              designation: p.designation,
              descriptor: p.descriptor,
            })),
          });
        }

        await CaseCopySvc.writeIn(tx, source.consultations, documents, files, ids, target);

        if (source.timelineEvents.length) {
          await tx.caseTimelineEvent.createMany({
            data: source.timelineEvents.map((e) => ({
              caseId,
              copiedFromId: e.id,
              title: e.title,
              occurredOn: e.occurredOn,
              description: e.description,
              status: e.status,
              source: e.source,
              documentId: mapped(ids.documents, e.documentId),
              // Chunk ids change when the copied document is re-indexed.
              chunkId: null,
              pageNumber: e.pageNumber,
              createdBy: e.createdBy,
              createdAt: e.createdAt,
            })),
          });
        }

        if (source.events.length) {
          await tx.event.createMany({
            data: source.events.map((e) => ({
              copiedFromId: e.id,
              userId: request.userId,
              organizationId: request.targetOrganizationId,
              caseId,
              title: e.title,
              type: e.type,
              dateTime: e.dateTime,
              endDateTime: e.endDateTime,
              clientEmail: e.clientEmail,
              notes: e.notes,
              status: e.status,
              lawyerAcknowledgedAt: e.lawyerAcknowledgedAt,
              clientFeedback: e.clientFeedback,
              dateSource: e.dateSource,
              // Not linked to anyone's Google Calendar and no reminders: the original event still
              // belongs to the organization, and the copy shouldn't send a second round of them.
            })),
          });
        }
      },
      { timeout: 60_000 },
    );

    DocumentExtractionQueue.enqueueMany([...ids.documents.values()]);
    return caseId;
  }

  /** Returns the copy's consultation id. Reuses a copy that already holds as many messages as the
   * original, so a retried job — or leaving, rejoining and leaving again with no new messages —
   * doesn't duplicate it. */
  static async copyConsultation(request: ConsultationCopyRequest): Promise<string> {
    const source = await prisma.consultation.findUnique({ where: { id: request.sourceConsultationId }, include: CONSULTATION_INCLUDE });
    if (!source || source.status === ConsultationStatus.FOR_DELETION) {
      throw new CaseCopyAbandoned("The original consultation was deleted before it could be copied");
    }

    const existing = await prisma.consultation.findFirst({
      where: { copiedFromId: source.id, organizationId: request.targetOrganizationId, caseId: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, _count: { select: { messages: true } } },
    });
    if (existing && existing._count.messages === source.messages.length) return existing.id;

    const target: Target = { userId: request.userId, organizationId: request.targetOrganizationId, caseId: null, sourceCaseId: null };
    const { ids, documents, files } = await CaseCopySvc.prepare(
      [source],
      [],
      (fileId, ext, ids) => `documents/consultations/${ids.consultations.get(source.id)}/${Date.now()}-${fileId.slice(0, 8)}${ext}`,
    );

    await prisma.$transaction((tx) => CaseCopySvc.writeIn(tx, [source], documents, files, ids, target), { timeout: 60_000 });

    DocumentExtractionQueue.enqueueMany([...ids.documents.values()]);
    return ids.consultations.get(source.id)!;
  }

  /** Assigns every new id and copies the files in S3 — outside the transaction (network calls).
   * If the transaction then fails, the copied objects are orphaned but harmless, and the retry
   * copies them afresh. `keyFor` names a copied file's S3 key. */
  private static async prepare(
    consultations: SourceConsultation[],
    ownDocuments: SourceDocument[],
    keyFor: (fileId: string, ext: string, ids: IdMaps) => string,
  ) {
    const ids: IdMaps = {
      consultations: new Map(consultations.map((c) => [c.id, crypto.randomUUID()])),
      groups: new Map(consultations.flatMap((c) => c.messageGroups.map((g) => [g.id, crypto.randomUUID()] as const))),
      messages: new Map(consultations.flatMap((c) => c.messages.map((m) => [m.id, crypto.randomUUID()] as const))),
      documents: new Map(),
      files: new Map(),
    };

    // A document can hang off the case, one of its consultations, or both — copy each once.
    const documents = new Map<string, SourceDocument>();
    for (const doc of [...ownDocuments, ...consultations.flatMap((c) => c.documents)]) documents.set(doc.id, doc);
    for (const id of documents.keys()) ids.documents.set(id, crypto.randomUUID());

    const files: Prisma.FileCreateManyInput[] = [];
    for (const doc of documents.values()) {
      const file = doc.file;
      if (!file || ids.files.has(file.id)) continue;
      const fileId = crypto.randomUUID();
      ids.files.set(file.id, fileId);
      let s3Key = file.s3Key;
      let fileUrl = file.fileUrl;
      if (file.s3Key) {
        s3Key = keyFor(fileId, path.extname(file.s3Key), ids);
        await CaseCopySvc.copyObject(file.s3Key, s3Key);
        fileUrl = s3UrlForKey(s3Key);
      }
      files.push({
        id: fileId,
        filename: file.filename,
        fileUrl,
        s3Key,
        metaData: file.metaData === null ? Prisma.DbNull : (file.metaData as Prisma.InputJsonValue),
        fileStatus: file.fileStatus,
      });
    }

    return { ids, documents: [...documents.values()], files };
  }

  /** Writes the copied consultations (with their message groups and messages), files and documents. */
  private static async writeIn(
    tx: Prisma.TransactionClient,
    consultations: SourceConsultation[],
    documents: SourceDocument[],
    files: Prisma.FileCreateManyInput[],
    ids: IdMaps,
    target: Target,
  ) {
    for (const c of consultations) {
      const consultationId = ids.consultations.get(c.id)!;
      await tx.consultation.create({
        data: {
          id: consultationId,
          copiedFromId: c.id,
          userId: target.userId,
          organizationId: target.organizationId,
          caseId: target.caseId,
          title: c.title,
          titleSource: c.titleSource,
          createdAt: c.createdAt,
          urgentAt: c.urgentAt,
          status: c.status,
          archivedAt: c.archivedAt,
        },
      });
      if (c.messageGroups.length) {
        await tx.messageGroup.createMany({
          data: c.messageGroups.map((g) => ({ id: ids.groups.get(g.id)!, consultationId, createdAt: g.createdAt })),
        });
      }
      if (c.messages.length) {
        // Threads are re-linked below, once every message in the consultation exists.
        await tx.message.createMany({
          data: c.messages.map((m) => ({
            id: ids.messages.get(m.id)!,
            consultationId,
            role: m.role,
            content: m.content,
            imagePreview: m.imagePreview,
            timestamp: m.timestamp,
            createdAt: m.createdAt,
            userId: m.userId,
            groupId: mapped(ids.groups, m.groupId),
            groupOrder: m.groupOrder,
            groupTitle: m.groupTitle,
            replyStatus: m.replyStatus,
            pendingReplyContent: m.pendingReplyContent,
            urgent: m.urgent,
            urgencyProbability: m.urgencyProbability,
            intent: m.intent,
            intentConfidence: m.intentConfidence,
            refersToAttachment: m.refersToAttachment,
          })),
        });
        for (const m of c.messages) {
          const parentMessageId = mapped(ids.messages, m.parentMessageId);
          if (parentMessageId) {
            await tx.message.update({ where: { id: ids.messages.get(m.id)! }, data: { parentMessageId } });
          }
        }
      }
    }

    if (files.length) await tx.file.createMany({ data: files });

    if (documents.length) {
      await tx.document.createMany({
        data: documents.map((d) => ({
          id: ids.documents.get(d.id)!,
          copiedFromId: d.id,
          userId: target.userId,
          organizationId: target.organizationId,
          caseId: target.sourceCaseId && d.caseId === target.sourceCaseId ? target.caseId : null,
          consultationId: mapped(ids.consultations, d.consultationId),
          messageId: mapped(ids.messages, d.messageId),
          name: d.name,
          fileId: mapped(ids.files, d.fileId),
          documentType: d.documentType,
          category: d.category,
          fileSize: d.fileSize,
          mimeType: d.mimeType,
          language: d.language,
          isExhibit: d.isExhibit,
          status: d.status,
          createdAt: d.createdAt,
          // ragStatus defaults to PENDING: the copy is re-indexed from scratch.
        })),
      });
    }
  }
}
