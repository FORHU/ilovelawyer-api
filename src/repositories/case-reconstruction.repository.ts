import prisma from "../lib/prisma";
import type { ReconstructionClaim } from "../utils/case-reconstruction-claims-parse";
import type { Scene } from "../utils/case-reconstruction-scenes-parse";
import { Prisma } from "@prisma/client";

export interface ReconstructionUpsertData {
  narrative: string;
  narrativeCourt?: string | null;
  narrativeOpposing?: string | null;
  gaps?: string[];
  claims?: ReconstructionClaim[] | undefined;
}

export interface ReconstructionEditData {
  narrative?: string;
  narrativeCourt?: string | null;
  narrativeOpposing?: string | null;
}

export default class CaseReconstructionRepo {
  static async get(caseId: string) {
    return prisma.caseReconstruction.findUnique({ where: { caseId } });
  }

  static async upsert(caseId: string, data: ReconstructionUpsertData) {
    const { claims, ...rest } = data;
    const claimsJson = claims ? (claims as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
    return prisma.caseReconstruction.upsert({
      where: { caseId },
      // A fresh generate hands the narrative back to the AI, so it is no longer "edited".
      create: { caseId, ...rest, claims: claimsJson },
      update: { ...rest, claims: claimsJson, narrativeEditedAt: null },
    });
  }

  /** Update-only (no create branch) — editing implies a reconstruction already exists from a
   * prior generate(). Returns null (not a thrown error) when there's nothing to edit, letting
   * the service layer decide how to surface that as a 404. */
  static async updateFields(caseId: string, data: ReconstructionEditData) {
    const existing = await prisma.caseReconstruction.findUnique({ where: { caseId }, select: { id: true } });
    if (!existing) return null;
    // Hand-editing the narrative invalidates any claims matched against its old text — a
    // verbatim-substring match against the new text would either silently miss (safe) or, worse,
    // land on a coincidentally-matching but now-wrong sentence. Clearing is the safer default.
    const claimsUpdate = data.narrative !== undefined ? { claims: Prisma.JsonNull } : {};
    // Any register edited marks the narrative as the lawyer's, so the analysis refresh stops
    // regenerating it (CaseReconstructionSvc.autoRegenerate).
    const edited = Object.values(data).some((v) => v !== undefined) ? { narrativeEditedAt: new Date() } : {};
    return prisma.caseReconstruction.update({ where: { caseId }, data: { ...data, ...claimsUpdate, ...edited } });
  }

  /** `scenes: null` clears the script (not currently exposed as a lawyer action, but keeps the
   * type honest — a reconstruction can predate Rung 1 or have generation fail outright). */
  static async updateScenes(caseId: string, scenes: Scene[] | null) {
    return prisma.caseReconstruction.update({
      where: { caseId },
      data: { scenes: scenes ? (scenes as unknown as Prisma.InputJsonValue) : Prisma.JsonNull },
    });
  }
}
