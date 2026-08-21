import prisma from "../lib/prisma";

export interface ModelSettingDto {
  toolName: string;
  description: string | null;
  currentModel: string;
  availableModels: string[];
  locked: boolean;
}

function toDto(row: {
  toolName: string;
  description: string | null;
  currentModel: string;
  availableModels: unknown;
  locked: boolean;
}): ModelSettingDto {
  return {
    toolName: row.toolName,
    description: row.description,
    currentModel: row.currentModel,
    availableModels: Array.isArray(row.availableModels) ? (row.availableModels as string[]) : [],
    locked: row.locked,
  };
}

export default class ModelSettingsSvc {
  static async list(): Promise<ModelSettingDto[]> {
    const rows = await prisma.modelSetting.findMany({ orderBy: { toolName: "asc" } });
    return rows.map(toDto);
  }

  static async update(toolName: string, model: string): Promise<ModelSettingDto | null> {
    const existing = await prisma.modelSetting.findUnique({ where: { toolName } });
    if (!existing) return null;
    if (existing.locked) throw new LockedToolError(toolName);

    const updated = await prisma.modelSetting.update({
      where: { toolName },
      data: { currentModel: model },
    });
    return toDto(updated);
  }
}

export class LockedToolError extends Error {
  constructor(toolName: string) {
    super(`"${toolName}" is locked and cannot be changed.`);
    this.name = "LockedToolError";
  }
}
