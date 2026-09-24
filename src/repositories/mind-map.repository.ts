import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MindMapItem } from "../utils/response-parser";

/** Thrown when the map moved on (another expand/undo landed) between reading it and saving —
 * MindMapSvc re-reads and re-applies its change instead of overwriting the other one. */
export class MindMapVersionConflictError extends Error {
  constructor() {
    super("Mind map changed while saving");
  }
}

const asJson = (tree: MindMapItem) => tree as unknown as Prisma.InputJsonValue;

export default class MindMapRepo {
  /** The map a consultation's Mind Map tab / Studio panel is currently showing: the newest
   * message's map that has at least one branch — same rule as the app's getActiveMindMap
   * (lib/chat/mind-map-parser.ts), which walks the history back-to-front the same way. */
  static async findActiveForConsultation(consultationId: string) {
    const rows = await prisma.messageMindMap.findMany({
      where: { message: { consultationId } },
      orderBy: { message: { createdAt: "desc" } },
      take: 20,
    });
    return (
      rows.find((row) => {
        const kids = (row.data as any)?.children;
        return Array.isArray(kids) && kids.length > 0;
      }) ?? null
    );
  }

  static async findByMessage(consultationId: string, messageId: string) {
    return prisma.messageMindMap.findFirst({ where: { messageId, message: { consultationId } } });
  }

  static async findById(id: string) {
    return prisma.messageMindMap.findUnique({ where: { id } });
  }

  /**
   * Replaces the map's tree and records it as a new revision, but only if the map is still at
   * `expectedVersion` — otherwise throws MindMapVersionConflictError and writes nothing.
   * `previousData` backfills the version being replaced when it has no revision row yet (every
   * map's first edit, since generation itself doesn't write one), so undo can always reach it.
   */
  static async saveNewVersion(p: {
    mindMapId: string;
    expectedVersion: number;
    previousData: MindMapItem;
    data: MindMapItem;
    reason: "expand" | "edit";
    nodeId: string;
    userId: string;
  }) {
    const nextVersion = p.expectedVersion + 1;
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.messageMindMap.updateMany({
        where: { id: p.mindMapId, version: p.expectedVersion },
        data: { data: asJson(p.data), version: nextVersion },
      });
      if (count === 0) throw new MindMapVersionConflictError();

      const hasPrevious = await tx.mindMapRevision.findUnique({
        where: { messageMindMapId_version: { messageMindMapId: p.mindMapId, version: p.expectedVersion } },
        select: { id: true },
      });
      if (!hasPrevious) {
        await tx.mindMapRevision.create({
          data: {
            messageMindMapId: p.mindMapId,
            version: p.expectedVersion,
            data: asJson(p.previousData),
            reason: "generate",
          },
        });
      }
      await tx.mindMapRevision.create({
        data: {
          messageMindMapId: p.mindMapId,
          version: nextVersion,
          data: asJson(p.data),
          reason: p.reason,
          nodeId: p.nodeId,
          createdById: p.userId,
        },
      });
      return { version: nextVersion };
    });
  }

  /** Steps back one version: restores the revision before `expectedVersion` and drops every
   * revision after it. 409 when there's nothing to undo; MindMapVersionConflictError when the
   * map moved on since the caller read it. */
  static async revertOneVersion(mindMapId: string, expectedVersion: number) {
    return prisma.$transaction(async (tx) => {
      const previous = await tx.mindMapRevision.findFirst({
        where: { messageMindMapId: mindMapId, version: { lt: expectedVersion } },
        orderBy: { version: "desc" },
      });
      if (!previous) throw new HttpError("Nothing to undo on this mind map", 409);

      const { count } = await tx.messageMindMap.updateMany({
        where: { id: mindMapId, version: expectedVersion },
        data: { data: previous.data as Prisma.InputJsonValue, version: previous.version },
      });
      if (count === 0) throw new MindMapVersionConflictError();

      await tx.mindMapRevision.deleteMany({ where: { messageMindMapId: mindMapId, version: { gt: previous.version } } });
      return { version: previous.version, data: previous.data as unknown as MindMapItem };
    });
  }
}
