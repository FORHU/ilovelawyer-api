import crypto from "crypto";
import path from "path";
import { ConsultationStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { copyS3Object, s3UrlForKey } from "../utils/s3";
import DocumentExtractionQueue from "../queues/document-extraction.queue";

/** Thrown for a copy that can never succeed (e.g. the original is gone) — not retried. */
export class CaseCopyAbandoned extends Error {}

type CopyRequest = { sourceCaseId: string; userId: string; targetOrganizationId: string; sourceOrganizationName: string };

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
        consultations: {
          where: { status: { not: ConsultationStatus.FOR_DELETION } },
          include: { messages: true, messageGroups: true, documents: { include: { file: true } } },
        },
      },
    });
    if (!source) throw new CaseCopyAbandoned("The original case was deleted before it could be copied");

    const existing = await prisma.case.findFirst({
      where: { copiedFromCaseId: source.id, organizationId: request.targetOrganizationId, copiedAt: { gte: source.updatedAt } },
      select: { id: true },
    });
    if (existing) return existing.id;

    const caseId = crypto.randomUUID();
    const consultationIds = new Map(source.consultations.map((c) => [c.id, crypto.randomUUID()]));
    const groupIds = new Map(source.consultations.flatMap((c) => c.messageGroups.map((g) => [g.id, crypto.randomUUID()] as const)));
    const messageIds = new Map(source.consultations.flatMap((c) => c.messages.map((m) => [m.id, crypto.randomUUID()] as const)));

    // A document can hang off the case, one of its consultations, or both — copy each once.
    const documents = new Map<string, (typeof source.documents)[number]>();
    for (const doc of [...source.documents, ...source.consultations.flatMap((c) => c.documents)]) documents.set(doc.id, doc);
    const documentIds = new Map([...documents.keys()].map((id) => [id, crypto.randomUUID()]));

    // Files first, outside the transaction (network calls). If the transaction then fails, the
    // copied objects are orphaned but harmless, and the retry copies them afresh.
    const files: Prisma.FileCreateManyInput[] = [];
    const fileIds = new Map<string, string>();
    for (const doc of documents.values()) {
      const file = doc.file;
      if (!file || fileIds.has(file.id)) continue;
      const fileId = crypto.randomUUID();
      fileIds.set(file.id, fileId);
      let s3Key = file.s3Key;
      let fileUrl = file.fileUrl;
      if (file.s3Key) {
        s3Key = `documents/cases/${caseId}/${Date.now()}-${fileId.slice(0, 8)}${path.extname(file.s3Key)}`;
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

    const mapped = <T>(ids: Map<string, string>, id: T | null) => (id ? (ids.get(id as string) ?? null) : null);

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

        for (const c of source.consultations) {
          const consultationId = consultationIds.get(c.id)!;
          await tx.consultation.create({
            data: {
              id: consultationId,
              copiedFromId: c.id,
              userId: request.userId,
              organizationId: request.targetOrganizationId,
              caseId,
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
              data: c.messageGroups.map((g) => ({ id: groupIds.get(g.id)!, consultationId, createdAt: g.createdAt })),
            });
          }
          if (c.messages.length) {
            // Threads are re-linked below, once every message in the consultation exists.
            await tx.message.createMany({
              data: c.messages.map((m) => ({
                id: messageIds.get(m.id)!,
                consultationId,
                role: m.role,
                content: m.content,
                imagePreview: m.imagePreview,
                timestamp: m.timestamp,
                createdAt: m.createdAt,
                userId: m.userId,
                groupId: mapped(groupIds, m.groupId),
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
              const parentMessageId = mapped(messageIds, m.parentMessageId);
              if (parentMessageId) {
                await tx.message.update({ where: { id: messageIds.get(m.id)! }, data: { parentMessageId } });
              }
            }
          }
        }

        if (files.length) await tx.file.createMany({ data: files });

        if (documents.size) {
          await tx.document.createMany({
            data: [...documents.values()].map((d) => ({
              id: documentIds.get(d.id)!,
              copiedFromId: d.id,
              userId: request.userId,
              organizationId: request.targetOrganizationId,
              caseId: d.caseId === source.id ? caseId : null,
              consultationId: mapped(consultationIds, d.consultationId),
              messageId: mapped(messageIds, d.messageId),
              name: d.name,
              fileId: mapped(fileIds, d.fileId),
              documentType: d.documentType,
              category: d.category,
              fileSize: d.fileSize,
              mimeType: d.mimeType,
              language: d.language,
              isExhibit: d.isExhibit,
              status: d.status,
              createdAt: d.createdAt,
              // ragStatus defaults to PENDING: the copy is re-indexed from scratch below.
            })),
          });
        }

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
              documentId: mapped(documentIds, e.documentId),
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

    DocumentExtractionQueue.enqueueMany([...documentIds.values()]);
    return caseId;
  }
}
