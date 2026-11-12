import Joi from "joi";
import { updateClientCaseSchema } from "./client-case.validation";
import { UK_JURISDICTIONS } from "./case.validation";

/** Chat Wonder's create_case intake tool calls PATCH /api/v1/intake-cases/:caseId with the real case
 * details it drafted, plus the client's userId (there's no session on this service-to-service
 * request). Every field rule is updateClientCaseSchema's own; only userId is added, the legacy
 * singular `area` is forbidden (chat-wonder only ever sends `areas`, and silently accepting it would
 * mean a 200 that changed nothing), and at least one real case-detail field is required alongside
 * userId (otherwise `.min(1)` is satisfied by userId alone and the update runs with nothing in it).
 *
 * A null ukJurisdiction is dropped, not saved: from the AI it means "I don't know yet", and saving it
 * would read as "outside the UK" (#973). The AI says outside the UK with `outsideUk: true` instead. */
export const updateIntakeCaseSchema = updateClientCaseSchema
  .keys({
    userId: Joi.string().required(),
    area: Joi.forbidden(),
    ukJurisdiction: Joi.string()
      .valid(...UK_JURISDICTIONS)
      .empty(null),
  })
  .or("title", "areas", "ukJurisdiction", "outsideUk", "where", "side", "others", "notes");
