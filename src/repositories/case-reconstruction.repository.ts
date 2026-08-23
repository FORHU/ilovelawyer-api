import prisma from "../lib/prisma";
import { getPresignedGetUrl } from "../utils/s3";

export interface ReconstructionUpsertData {
  narrative: string;
  narrativeCourt?: string | null;
  narrativeOpposing?: string | null;
  gaps?: string[];
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
    return prisma.caseReconstruction.upsert({
      where: { caseId },
      create: { caseId, ...data },
      update: data,
    });
  }

  /** Update-only (no create branch) — editing implies a reconstruction already exists from a
   * prior generate(). Returns null (not a thrown error) when there's nothing to edit, letting
   * the service layer decide how to surface that as a 404. */
  static async updateFields(caseId: string, data: ReconstructionEditData) {
    const existing = await prisma.caseReconstruction.findUnique({ where: { caseId }, select: { id: true } });
    if (!existing) return null;
    return prisma.caseReconstruction.update({ where: { caseId }, data });
  }

  static async updateAudio(caseId: string, data: ReconstructionAudioUpdate) {
    return prisma.caseReconstruction.update({ where: { caseId }, data });
  }
}
