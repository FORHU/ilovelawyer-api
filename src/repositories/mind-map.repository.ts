import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MindMapItem } from "../utils/response-parser";

/** Thrown when the map moved on (another expand/undo/rebuild landed) between reading it and
 * saving — MindMapSvc re-reads and re-applies its change instead of overwriting the other one. */
export class MindMapVersionConflictError extends Error {
  constructor() {
    super("Mind map changed while saving");
  }
}

/** Which table a map lives in: a chat turn's map (MessageMindMap) or the case's document-built
 * map (CaseMindMap). Both have the same `data`/`version` contract and share MindMapRevision. */
export type MindMapKind = "message" | "case";

/** "check" = Jev's verdicts merged onto the map (mind-map-jev.ts); "sync" = citations to removed
 * documents dropped (CaseMindMapSvc). Neither is a user change. */
export type MindMapRevisionReason = "generate" | "auto" | "expand" | "edit" | "check" | "sync";

const asJson = (tree: MindMapItem) => tree as unknown as Prisma.InputJsonValue;
const ownerField = (kind: MindMapKind) => (kind === "message" ? "messageMindMapId" : "caseMindMapId");

/** The one update both kinds need, behind the kind switch Prisma's per-model delegates force. */
function updateIfVersion(
  tx: Prisma.TransactionClient,
  kind: MindMapKind,
  id: string,
  expectedVersion: number,
  data: Prisma.MessageMindMapUpdateManyMutationInput & Prisma.CaseMindMapUpdateManyMutationInput,
) {
  const where = { id, version: expectedVersion };
  return kind === "message" ? tx.messageMindMap.updateMany({ where, data }) : tx.caseMindMap.updateMany({ where, data });
}

export default class MindMapRepo {
  /** The map a consultation's Mind Map tab shows: the newest message's map that has at least one
   * branch — same rule as the app's getActiveMindMap (lib/chat/mind-map-parser.ts). */
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

  static async findCaseMap(caseId: string) {
    return prisma.caseMindMap.findUnique({ where: { caseId } });
  }

  /** Everything about the case map except the tree itself — for the case snapshot, which only
   * needs to say whether one exists, how fresh it is and what it was built from. */
  static async findCaseMapMeta(caseId: string) {
    return prisma.caseMindMap.findUnique({
      where: { caseId },
      select: { id: true, version: true, generatedAt: true, documentCount: true, readySetFingerprint: true, documentIds: true, retiredAt: true },
    });
  }

  static async findById(kind: MindMapKind, id: string) {
    return kind === "message"
      ? prisma.messageMindMap.findUnique({ where: { id } })
      : prisma.caseMindMap.findUnique({ where: { id } });
  }

  /** Whether anyone expanded/edited the case map since its last build. Asked as "any expand/edit
   * after the newest build" rather than "is the newest version a user change" — Jev's "check"
   * versions land on top of both builds and expansions, and must neither make an expanded map
   * look safe to overwrite nor make a fresh build look expanded. Undoing every expansion removes
   * them, so the map becomes rebuildable again. */
  static async caseMapHasUserChanges(caseMindMapId: string): Promise<boolean> {
    return (await MindMapRepo.countCaseMapChangesSinceBuild(caseMindMapId)) > 0;
  }

  /** Expands/edits on the case map since its newest build — what Regenerate would throw away
   * (the app's "…including N expanded branches" warning). */
  static async countCaseMapChangesSinceBuild(caseMindMapId: string): Promise<number> {
    const build = await prisma.mindMapRevision.findFirst({
      where: { caseMindMapId, reason: "auto" },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return prisma.mindMapRevision.count({
      where: { caseMindMapId, version: { gt: build?.version ?? 0 }, reason: { in: ["expand", "edit"] } },
    });
  }

  /**
   * Replaces a map's tree and records it as a new revision, but only if the map is still at
   * `expectedVersion` — otherwise throws MindMapVersionConflictError and writes nothing.
   * `previousData` backfills the version being replaced when it has no revision row yet (a
   * message map's first edit, since chat generation itself doesn't write one), so undo can
   * always reach it.
   */
  static async saveNewVersion(p: {
    kind: MindMapKind;
    mindMapId: string;
    expectedVersion: number;
    previousData: MindMapItem;
    data: MindMapItem;
    reason: "expand" | "edit" | "check" | "sync";
    /** The node acted on; absent for "check", which touches many. */
    nodeId?: string;
    /** Absent for "check" (a background job, not a person). */
    userId?: string;
  }) {
    const owner = ownerField(p.kind);
    const nextVersion = p.expectedVersion + 1;
    return prisma.$transaction(async (tx) => {
      const { count } = await updateIfVersion(tx, p.kind, p.mindMapId, p.expectedVersion, {
        data: asJson(p.data),
        version: nextVersion,
      });
      if (count === 0) throw new MindMapVersionConflictError();

      const hasPrevious = await tx.mindMapRevision.findFirst({
        where: { [owner]: p.mindMapId, version: p.expectedVersion },
        select: { id: true },
      });
      if (!hasPrevious) {
        await tx.mindMapRevision.create({
          data: {
            [owner]: p.mindMapId,
            version: p.expectedVersion,
            data: asJson(p.previousData),
            reason: p.kind === "message" ? "generate" : "auto",
          },
        });
      }
      await tx.mindMapRevision.create({
        data: {
          [owner]: p.mindMapId,
          version: nextVersion,
          data: asJson(p.data),
          reason: p.reason,
          nodeId: p.nodeId ?? null,
          createdById: p.userId ?? null,
        },
      });
      return { version: nextVersion };
    });
  }

  /**
   * Saves a fresh document build of the case's map as its newest version (creating the map on
   * the case's first build). `expectedVersion` is the version the builder decided to replace
   * (null = "no map yet") — if the map moved on meanwhile (someone expanded it while the model was
   * running), throws MindMapVersionConflictError so the caller can re-check before overwriting.
   */
  static async saveCaseBuild(p: {
    caseId: string;
    expectedVersion: number | null;
    data: MindMapItem;
    readySetFingerprint: string;
    documentIds: string[];
    userId?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      // A build is always of the case's current documents, so it also un-retires the map.
      const meta = {
        readySetFingerprint: p.readySetFingerprint,
        documentIds: p.documentIds,
        documentCount: p.documentIds.length,
        generatedAt: new Date(),
        retiredAt: null,
      };
      let id: string;
      let version: number;
      if (p.expectedVersion === null) {
        const existing = await tx.caseMindMap.findUnique({ where: { caseId: p.caseId }, select: { id: true } });
        if (existing) throw new MindMapVersionConflictError();
        const created = await tx.caseMindMap.create({ data: { caseId: p.caseId, data: asJson(p.data), version: 1, ...meta } });
        id = created.id;
        version = 1;
      } else {
        const existing = await tx.caseMindMap.findUnique({ where: { caseId: p.caseId }, select: { id: true } });
        if (!existing) throw new MindMapVersionConflictError();
        version = p.expectedVersion + 1;
        const { count } = await updateIfVersion(tx, "case", existing.id, p.expectedVersion, { data: asJson(p.data), version, ...meta });
        if (count === 0) throw new MindMapVersionConflictError();
        id = existing.id;
      }
      await tx.mindMapRevision.create({
        data: { caseMindMapId: id, version, data: asJson(p.data), reason: "auto", createdById: p.userId ?? null },
      });
      return { id, version };
    });
  }

  /** Hides the case map because every document it was built from is gone (see
   * CaseMindMap.retiredAt). Keeps the row and its versions; the next build clears it. */
  static async retireCaseMap(caseMindMapId: string) {
    return prisma.caseMindMap.update({ where: { id: caseMindMapId }, data: { retiredAt: new Date() } });
  }

  /** Steps back one version: restores the revision before `expectedVersion` and drops every
   * revision after it. 409 when there's nothing to undo; MindMapVersionConflictError when the
   * map moved on since the caller read it. */
  static async revertOneVersion(kind: MindMapKind, mindMapId: string, expectedVersion: number) {
    const owner = ownerField(kind);
    return prisma.$transaction(async (tx) => {
      const previous = await tx.mindMapRevision.findFirst({
        where: { [owner]: mindMapId, version: { lt: expectedVersion } },
        orderBy: { version: "desc" },
      });
      if (!previous) throw new HttpError("Nothing to undo on this mind map", 409);

      const { count } = await updateIfVersion(tx, kind, mindMapId, expectedVersion, {
        data: previous.data as Prisma.InputJsonValue,
        version: previous.version,
      });
      if (count === 0) throw new MindMapVersionConflictError();

      await tx.mindMapRevision.deleteMany({ where: { [owner]: mindMapId, version: { gt: previous.version } } });
      return { version: previous.version, data: previous.data as unknown as MindMapItem };
    });
  }
}
