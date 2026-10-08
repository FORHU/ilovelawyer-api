import { ConnectorStatus, ConnectorType } from "@prisma/client";
import IntegrationRepo from "../repositories/integration.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";

export default class IntegrationSvc {
  static async list(userId: string, organizationId?: string) {
    return IntegrationRepo.list(userId, organizationId);
  }

  static async create(
    userId: string,
    body: { type: ConnectorType; organizationId?: string; configJson?: object },
  ) {
    return IntegrationRepo.create({
      userId,
      organizationId: body.organizationId ?? null,
      type: body.type,
      status: "DISCONNECTED",
      configJson: body.configJson,
    });
  }

  static async connect(id: string, userId: string, configJson?: object) {
    const row = await IntegrationRepo.updateStatus(id, userId, "CONNECTED" as ConnectorStatus, configJson);
    if (!row) throw new HttpError("Connector not found", 404);
    await SecurityAuditSvc.record({ action: "integration.connected", actorId: userId, targetType: "integration", targetId: id, payload: { type: row.type } });
    return row;
  }

  static async disconnect(id: string, userId: string) {
    const row = await IntegrationRepo.updateStatus(id, userId, "DISCONNECTED");
    if (!row) throw new HttpError("Connector not found", 404);
    await SecurityAuditSvc.record({ action: "integration.disconnected", actorId: userId, targetType: "integration", targetId: id, payload: { type: row.type } });
    return row;
  }
}
