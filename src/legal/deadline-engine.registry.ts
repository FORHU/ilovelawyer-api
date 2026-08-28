import { TenantCode } from "../types/tenant-code";
import { DeadlineEngine } from "./types";
import { PHDeadlineEngine } from "./ph/deadline/ph-deadline.engine";
import { UKDeadlineEngine } from "./uk/deadline/uk-deadline.engine";
import HttpError from "../utils/http-error";

const phEngine = new PHDeadlineEngine();
const ukEngine = new UKDeadlineEngine();

/** Selects the deadline engine strictly by tenantCode — never by client input, never with a
 * fallback between jurisdictions. An unmapped tenantCode is a hard error, not a silent
 * PH default. */
export function getDeadlineEngine(tenantCode: TenantCode): DeadlineEngine {
  switch (tenantCode) {
    case "PH":
      return phEngine;
    case "UK":
      return ukEngine;
    default:
      throw new HttpError(`No deadline engine configured for tenantCode: ${tenantCode}`, 501);
  }
}
