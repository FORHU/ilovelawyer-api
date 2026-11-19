import { Request, Response } from "express";
import PersonaRoutingOverrideSvc, { ManualPinRequiredError } from "../services/persona-routing-override.service";
import { updatePersonaRoutingOverrideSchema } from "../validation/persona-routing-override.validation";
import HttpError from "../utils/http-error";

export default class PersonaRoutingOverrideCtrl {
  /** GET /api/admin/persona-routing — the settings page's list (requireAdmin). */
  static async listForAdmin(_req: Request, res: Response) {
    const overrides = await PersonaRoutingOverrideSvc.listForAdmin();
    return res.status(200).json({ overrides });
  }

  /** PATCH /api/admin/persona-routing/:persona (requireAdmin). */
  static async update(req: Request, res: Response) {
    const { persona } = req.params;
    const { error, value } = updatePersonaRoutingOverrideSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    try {
      const updated = await PersonaRoutingOverrideSvc.update(persona, value, req.user.userId);
      return res.status(200).json({ override: updated });
    } catch (err) {
      if (err instanceof ManualPinRequiredError) throw new HttpError(err.message, 400);
      throw err;
    }
  }

  /** GET /api/persona-routing — chat-wonder-v2-api's polling read (apiKeyMiddleware, no session). */
  static async listForChatWonder(_req: Request, res: Response) {
    const overrides = await PersonaRoutingOverrideSvc.listForChatWonder();
    return res.status(200).json({ overrides });
  }
}
