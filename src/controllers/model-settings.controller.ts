import { Request, Response } from "express";
import ModelSettingsSvc, { LockedToolError } from "../services/model-settings.service";

export default class ModelSettingsCtrl {
  static async list(_req: Request, res: Response) {
    const settings = await ModelSettingsSvc.list();
    return res.status(200).json({ settings });
  }

  static async update(req: Request, res: Response) {
    const { toolName } = req.params;
    const { model } = req.body;

    if (!model || typeof model !== "string") {
      return res.status(400).json({ message: "Provide a non-empty `model` string." });
    }

    try {
      const updated = await ModelSettingsSvc.update(toolName, model);
      if (!updated) {
        return res.status(404).json({ message: `Unknown tool "${toolName}".` });
      }
      return res.status(200).json({ setting: updated });
    } catch (err) {
      if (err instanceof LockedToolError) {
        return res.status(403).json({ message: err.message });
      }
      throw err;
    }
  }
}
