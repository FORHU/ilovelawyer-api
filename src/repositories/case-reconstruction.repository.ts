import prisma from "../lib/prisma";
import { getPresignedGetUrl } from "../utils/s3";
import type { ReconstructionClaim } from "../utils/case-reconstruction-claims-parse";
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

export interface ReconstructionAudioUpdate {
  audioFileId?: string | null;
  audioJobName?: string | null;
  audioStatus?: string | null;
  audioStaleAt?: Date | null;
}

export default class CaseReconstructionRepo {
  static async get(caseId: string) {
    const row = await prisma.caseReconstruction.findUnique({ where: { caseId }, include: { audioFile: true } });
    if (row?.audioFile?.s3Key) {
      row.audioFile.fileUrl = await getPresignedGetUrl(row.audioFile.s3Key);
    }
    return row;
  }

  static async upsert(caseId: string, data: ReconstructionUpsertData) {
    const { claims, ...rest } = data;
    const claimsJson = claims ? (claims as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
    return prisma.caseReconstruction.upsert({
      where: { caseId },
      create: { caseId, ...rest, claims: claimsJson },
      update: { ...rest, claims: claimsJson },
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
    return prisma.caseReconstruction.update({ where: { caseId }, data: { ...data, ...claimsUpdate } });
  }

  static async updateAudio(caseId: string, data: ReconstructionAudioUpdate) {
    return prisma.caseReconstruction.update({ where: { caseId }, data });
  }

  /** Re-queued on server start by CaseReconstructionAudioQueue — rows a prior process left
   * stuck mid-poll (crash/redeploy) rather than ever reaching COMPLETED/FAILED. */
  static async listInProgressAudio() {
    return prisma.caseReconstruction.findMany({
      where: { audioStatus: "IN_PROGRESS" },
      select: { caseId: true },
    });
  }
}
