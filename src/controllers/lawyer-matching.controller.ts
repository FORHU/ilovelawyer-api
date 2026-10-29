import { Request, Response } from "express";
import ClientRequestMatchingSvc, { type ClientBudget } from "../services/client-request-matching.service";

function budgetOf(body: unknown): ClientBudget | null | undefined {
  if (body === null || body === undefined) return body as null | undefined;
  if (typeof body !== "object") return undefined;
  const { minMinor, maxMinor, feePreference } = body as Record<string, unknown>;
  return {
    minMinor: typeof minMinor === "number" ? minMinor : null,
    maxMinor: typeof maxMinor === "number" ? maxMinor : null,
    feePreference: typeof feePreference === "string" ? feePreference : null,
  };
}

export default class LawyerMatchingCtrl {
  /** POST /lawyer-matching/by-criteria — chat-wonder's find_lawyer tool, and the client app's direct
   * "browse lawyers" feature, both ask here rather than needing a ClientRequest to exist first. */
  static async byCriteria(req: Request, res: Response) {
    const { caseAreas, ukJurisdiction, budget } = req.body ?? {};
    if (!Array.isArray(caseAreas) || caseAreas.some((a) => typeof a !== "string")) {
      return res.status(400).json({ message: "Provide `caseAreas` as a string array." });
    }
    if (ukJurisdiction !== null && typeof ukJurisdiction !== "string") {
      return res.status(400).json({ message: "Provide `ukJurisdiction` as a string, or null." });
    }
    const matches = await ClientRequestMatchingSvc.matchByCriteria({ caseAreas, ukJurisdiction, budget: budgetOf(budget) });
    return res.status(200).json({ matches });
  }
}
