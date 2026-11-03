import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import prisma from "../lib/prisma";
import ClientCaseSvc, { type ClientCaseChanges } from "../services/client-case.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { updateIntakeCaseSchema } from "../validation/intake-case.validation";

function validate<T>(schema: ObjectSchema<T>, body: unknown): T {
  const { error, value } = schema.validate(body, { stripUnknown: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** Chat Wonder's create_case intake tool calls this to write the real case details it drafted from
 * the interview onto a case that already exists. Service-to-service: no user session, so the
 * client's userId travels in the body and apiKeyMiddleware (not a session) guards the route. */
export default class IntakeCaseCtrl {
  static async update(req: Request, res: Response) {
    const { userId, ...rest } = validate<{ userId: string } & ClientCaseChanges>(updateIntakeCaseSchema, req.body);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, name: true, username: true } });
    if (user?.role !== "USER") {
      throw new HttpError("This is only available for client accounts", 403, "CLIENT_ACCOUNT_ONLY");
    }
    const workspace = await ClientCaseSvc.workspaceFor(userId, user.name || user.username);
    const result = await ClientCaseSvc.update(workspace, userId, req.params.caseId, rest);
    logger.info("Intake case: chat-wonder update applied", { caseId: req.params.caseId, userId, fields: Object.keys(rest) });
    res.status(200).json(result);
  }
}
