import { RoutingMode } from "@prisma/client";
import PersonaRoutingOverrideRepo from "../repositories/persona-routing-override.repository";
import SecurityAuditSvc from "./security-audit.service";

export interface PersonaRoutingOverrideDto {
  persona: string;
  routingMode: RoutingMode;
  manualPinnedModel: string | null;
  toolOverrides: Record<string, string> | null;
  updatedAt: string;
  updatedById: string | null;
}

function toDto(row: {
  persona: string;
  routingMode: RoutingMode;
  manualPinnedModel: string | null;
  toolOverrides: unknown;
  updatedAt: Date;
  updatedById: string | null;
}): PersonaRoutingOverrideDto {
  return {
    persona: row.persona,
    routingMode: row.routingMode,
    manualPinnedModel: row.manualPinnedModel,
    toolOverrides: (row.toolOverrides as Record<string, string> | null) ?? null,
    updatedAt: row.updatedAt.toISOString(),
    updatedById: row.updatedById,
  };
}

export default class PersonaRoutingOverrideSvc {
  /** The admin settings page: every persona that has ever been overridden. A persona with no row
   * is implicitly AUTO and isn't listed here — chat-wonder-v2-api's own env-var fallback covers it. */
  static async listForAdmin(): Promise<PersonaRoutingOverrideDto[]> {
    const rows = await PersonaRoutingOverrideRepo.listAll();
    return rows.map(toDto);
  }

  /** What chat-wonder-v2-api polls on its cache-refresh timer (api-key guarded, not session
   * guarded — there is no human in this request). Same rows, same shape, just the public read. */
  static async listForChatWonder(): Promise<PersonaRoutingOverrideDto[]> {
    const rows = await PersonaRoutingOverrideRepo.listAll();
    return rows.map(toDto);
  }

  static async update(
    persona: string,
    input: { routingMode: RoutingMode; manualPinnedModel?: string | null; toolOverrides?: Record<string, string> | null },
    updatedById: string,
  ): Promise<PersonaRoutingOverrideDto> {
    if (input.routingMode === "MANUAL" && !input.manualPinnedModel) {
      throw new ManualPinRequiredError(persona);
    }

    const before = await PersonaRoutingOverrideRepo.find(persona);
    const updated = await PersonaRoutingOverrideRepo.upsert(
      persona,
      {
        routingMode: input.routingMode,
        manualPinnedModel: input.routingMode === "MANUAL" ? (input.manualPinnedModel ?? null) : null,
        toolOverrides: input.toolOverrides ?? null,
      },
      updatedById,
    );

    await SecurityAuditSvc.record({
      action: "admin.persona_routing_override.updated",
      actorId: updatedById,
      organizationId: null,
      targetType: "persona_routing_override",
      targetId: persona,
      payload: {
        from: before ? { routingMode: before.routingMode, manualPinnedModel: before.manualPinnedModel } : null,
        to: { routingMode: updated.routingMode, manualPinnedModel: updated.manualPinnedModel },
      },
    });

    return toDto(updated);
  }
}

export class ManualPinRequiredError extends Error {
  constructor(persona: string) {
    super(`"${persona}" needs manualPinnedModel to switch to MANUAL.`);
    this.name = "ManualPinRequiredError";
  }
}
