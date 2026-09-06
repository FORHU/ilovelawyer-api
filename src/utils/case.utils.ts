import Joi from "joi";
import { partySchema } from "../validation/case.validation";
import { PartyInput } from "../repositories/case.repository";
import HttpError from "./http-error";

/** Converts legacy `"Name (Designation)"` into a parties array when `parties` is absent. */
export function normalizeCaseBody(value: {
  partyInvolved?: string;
  parties?: PartyInput[];
  [key: string]: unknown;
}) {
  const { partyInvolved, ...rest } = value;
  if (rest.parties || !partyInvolved?.trim()) return rest;

  const trimmed = partyInvolved.trim();
  const match = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const parties: PartyInput[] = match
    ? [{ name: match[1].trim(), designation: match[2].trim() }]
    : [{ name: trimmed, designation: "Petitioner / Plaintiff" }];

  const { error, value: validatedParties } = Joi.array().items(partySchema).validate(parties);
  if (error) throw new HttpError(error.message, 400);

  return { ...rest, parties: validatedParties };
}
