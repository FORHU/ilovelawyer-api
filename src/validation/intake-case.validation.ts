import Joi from "joi";
import { updateClientCaseSchema } from "./client-case.validation";

/** Chat Wonder's create_case intake tool calls PATCH /api/v1/intake-cases/:caseId with the real case
 * details it drafted, plus the client's userId (there's no session on this service-to-service
 * request). Every field rule is updateClientCaseSchema's own; only userId is added. */
export const updateIntakeCaseSchema = updateClientCaseSchema.keys({ userId: Joi.string().required() });
