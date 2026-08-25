import { Jurisdiction } from "../types/jurisdiction";
import { DeadlineEngine } from "./types";
import { PHDeadlineEngine } from "./ph/deadline/ph-deadline.engine";
import { UKDeadlineEngine } from "./uk/deadline/uk-deadline.engine";
import HttpError from "../utils/http-error";

const phEngine = new PHDeadlineEngine();
const ukEngine = new UKDeadlineEngine();

/** Selects the deadline engine strictly by jurisdiction — never by client input, never with a
 * fallback between jurisdictions. An unmapped jurisdiction is a hard error, not a silent
 * PH default. */
export function getDeadlineEngine(jurisdiction: Jurisdiction): DeadlineEngine {
  switch (jurisdiction) {
    case "PH":
      return phEngine;
    case "UK":
      return ukEngine;
    default:
      throw new HttpError(`No deadline engine configured for jurisdiction: ${jurisdiction}`, 501);
  }
}
