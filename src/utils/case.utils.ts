import Joi from "joi";
import { partySchema } from "../validation/case.validation";
import { PartyInput } from "../repositories/case.repository";
import HttpError from "./http-error";

const DEFAULT_DESIGNATION = "Petitioner / Plaintiff";

/** One `"Name (Designation)"` entry; a bare name gets the default designation. */
function parseLegacyParty(entry: string): PartyInput {
  const match = entry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  return match ? { name: match[1].trim(), designation: match[2].trim() } : { name: entry, designation: DEFAULT_DESIGNATION };
}

/** Converts legacy `"Name (Designation); Name (Designation)"` into a parties array when `parties`
 * is absent. Each `;`-separated entry is its own party — parsing the whole string as one party
 * gave a single party named "A (…); B (…); C" carrying only the last designation. */
export function normalizeCaseBody(value: {
  partyInvolved?: string;
  parties?: PartyInput[];
  [key: string]: unknown;
}) {
  const { partyInvolved, ...rest } = value;
  if (rest.parties || !partyInvolved?.trim()) return rest;

  const parties = partyInvolved
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseLegacyParty);

  const { error, value: validatedParties } = Joi.array().items(partySchema).validate(parties);
  if (error) throw new HttpError(error.message, 400);

  return { ...rest, parties: validatedParties };
}
