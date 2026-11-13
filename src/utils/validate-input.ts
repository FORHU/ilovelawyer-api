import type { ObjectSchema } from "joi";
import HttpError from "./http-error";

/** Checks `input` against a joi schema, answering 400 with the first complaint. Returns the converted value. */
export function validateInput<T>(schema: ObjectSchema<T>, input: unknown, code?: string): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400, code);
  return value;
}
