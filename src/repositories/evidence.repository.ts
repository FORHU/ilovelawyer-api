import prisma from "../lib/prisma";
import { PrivilegeStatus, HearsayCategory, ContradictionStatus, ContradictionNature } from "@prisma/client";
import { fieldEncryptionEnabled, isEncryptedField, openField, sealField } from "../utils/field-crypto";

const MATRIX_NOTES = "EvidenceMatrixItem.notes";
const CUSTODY_NOTES = "EvidenceCustodyEvent.notes";

const isPrivileged = (status: PrivilegeStatus | null | undefined) => !!status && status !== "NONE";

/** A matrix item as callers see it: its notes, and its custody events' notes, opened. Notes of a
 * privileged item are stored sealed (utils/field-crypto.ts) when field encryption is on. */
function revealMatrixItem<T extends { notes: string | null; custodyEvents?: { notes: string | null }[] }>(item: T): T {
  return {
    ...item,
    notes: openField(item.notes, MATRIX_NOTES),
    ...(item.custodyEvents ? { custodyEvents: item.custodyEvents.map((event) => ({ ...event, notes: openField(event.notes, CUSTODY_NOTES) })) } : {}),
  } as T;
}

function revealCustodyEvent<T extends { notes: string | null }>(event: T): T {
  return { ...event, notes: openField(event.notes, CUSTODY_NOTES) } as T;
}

/** The stored value to write so `stored` matches the wanted form (sealed for a privileged item
 * while encryption is on, plain otherwise), or undefined when it already does, is empty, or is
 * sealed and cannot be opened (left as it is rather than lost). */
function resealed(stored: string | null, label: string, protect: boolean): string | undefined {
  if (!stored) return undefined;
  const wantSealed = protect && fieldEncryptionEnabled();
  if (isEncryptedField(stored) === wantSealed) return undefined;
  const plain = openField(stored, label);
  if (plain === null) return undefined;
  return sealField(plain, label, protect);
}

export default class EvidenceRepo {
  static async findContradiction(id: string, caseId: string) {
    return prisma.evidenceContradiction.findFirst({ where: { id, caseId } });
  }

  static async findCustodyEvent(evidenceMatrixItemId: string, eventId: string) {
    const event = await prisma.evidenceCustodyEvent.findFirst({ where: { id: eventId, evidenceMatrixItemId } });
    return event ? revealCustodyEvent(event) : event;
  }

  static async listMatrix(caseId: string) {
    const items = await prisma.evidenceMatrixItem.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      include: { custodyEvents: { orderBy: { occurredAt: "desc" } } },
    });
    return items.map(revealMatrixItem);
  }

  static async upsertMatrix(
    caseId: string,
    documentId: string,
    data: {
      authenticity?: string;
      admissibility?: string;
      probative?: string;
      originalFile?: boolean;
      needsVerify?: boolean;
      notes?: string | null;
      privilegeStatus?: PrivilegeStatus;
      hearsayCategory?: HearsayCategory;
      sponsoringWitnessId?: string | null;
    },
  ) {
    const where = { caseId_documentId: { caseId, documentId } };
    return prisma.$transaction(async (tx) => {
      const existing = await tx.evidenceMatrixItem.findUnique({ where });
      // Privileged items keep their notes sealed; a change of status (or of the encryption setting)
      // moves the notes, and the custody notes below, into the form the item now needs.
      const protect = isPrivileged(data.privilegeStatus ?? existing?.privilegeStatus);
      const stored = { ...data };
      if (data.notes !== undefined) {
        stored.notes = sealField(data.notes, MATRIX_NOTES, protect);
      } else if (existing) {
        const next = resealed(existing.notes, MATRIX_NOTES, protect);
        if (next !== undefined) stored.notes = next;
      }
      const item = await tx.evidenceMatrixItem.upsert({
        where,
        create: { caseId, documentId, ...stored },
        update: stored,
        include: { custodyEvents: { orderBy: { occurredAt: "desc" } } },
      });
      for (const event of item.custodyEvents) {
        const next = resealed(event.notes, CUSTODY_NOTES, protect);
        if (next === undefined) continue;
        await tx.evidenceCustodyEvent.update({ where: { id: event.id }, data: { notes: next } });
        event.notes = next;
      }
      return revealMatrixItem(item);
    });
  }

  static async findMatrixItem(caseId: string, documentId: string) {
    const item = await prisma.evidenceMatrixItem.findUnique({ where: { caseId_documentId: { caseId, documentId } } });
    return item ? revealMatrixItem(item) : item;
  }

  static async addCustodyEvent(
    evidenceMatrixItemId: string,
    data: { custodianName: string; action: string; occurredAt: Date; notes?: string | null },
  ) {
    const parent = await prisma.evidenceMatrixItem.findUnique({ where: { id: evidenceMatrixItemId }, select: { privilegeStatus: true } });
    const created = await prisma.evidenceCustodyEvent.create({
      data: { evidenceMatrixItemId, ...data, notes: sealField(data.notes, CUSTODY_NOTES, isPrivileged(parent?.privilegeStatus)) },
    });
    return revealCustodyEvent(created);
  }

  static async deleteCustodyEvent(evidenceMatrixItemId: string, eventId: string) {
    const result = await prisma.evidenceCustodyEvent.deleteMany({
      where: { id: eventId, evidenceMatrixItemId },
    });
    return result.count > 0;
  }

  static async listContradictions(caseId: string) {
    return prisma.evidenceContradiction.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async replaceContradictions(
    caseId: string,
    rows: {
      kind: string;
      leftDocumentId: string;
      rightDocumentId: string;
      leftExcerpt: string;
      rightExcerpt: string;
      factKey: string;
      leftValue: string;
      rightValue: string;
      confidence: number;
      // Carried over from the previous scan's matching row, or set fresh — see
      // EvidenceIntelligenceSvc.scanContradictionsInner.
      status?: ContradictionStatus;
      resolutionNote?: string | null;
      resolvedAt?: Date | null;
      resolvedById?: string | null;
      nature?: ContradictionNature | null;
      natureConfidence?: number | null;
      leftLocator?: string | null;
      rightLocator?: string | null;
    }[],
  ) {
    await prisma.$transaction([
      prisma.evidenceContradiction.deleteMany({ where: { caseId } }),
      ...(rows.length
        ? [
            prisma.evidenceContradiction.createMany({
              data: rows.map((row) => ({ caseId, ...row })),
            }),
          ]
        : []),
    ]);
    return this.listContradictions(caseId);
  }

  static async updateContradictionStatus(
    id: string,
    caseId: string,
    data: { status: ContradictionStatus; resolutionNote: string | null; resolvedById: string | null },
  ) {
    const existing = await prisma.evidenceContradiction.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    const open = data.status === "OPEN";
    return prisma.evidenceContradiction.update({
      where: { id },
      data: {
        status: data.status,
        resolutionNote: open ? null : data.resolutionNote,
        resolvedAt: open ? null : new Date(),
        resolvedById: open ? null : data.resolvedById,
      },
    });
  }
}
