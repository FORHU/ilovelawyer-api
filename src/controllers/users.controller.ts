import { Request, Response } from "express";
import UsersSvc from "../services/users.service";
import { sendExportZip, exportAuditPayload } from "../utils/export-response";
import SecurityAuditSvc from "../services/security-audit.service";
import AvatarSvc from "../services/avatar.service";
import GoogleCalendarSvc from "../services/google-calendar.service";
import ProductTourSvc from "../services/product-tour.service";
import HttpError from "../utils/http-error";
import { clearRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { updateMeSchema, changePasswordSchema, deleteMeSchema, connectGoogleCalendarSchema, saveProductTourSchema } from "../validation/users.validation";
import { PRODUCT_TOUR_TRACKS } from "../constants";

export default class UsersCtrl {
  static async me(req: Request, res: Response) {
    const user = await UsersSvc.getMe(req.user.userId);
    return res.status(200).json(user);
  }

  static async updateMe(req: Request, res: Response) {
    const { name, username } = req.body;

    const { error, value } = updateMeSchema.validate({ name, username });
    if (error) throw new HttpError(error.message, 400);

    const user = await UsersSvc.updateMe(req.user.userId, value);
    return res.status(200).json(user);
  }

  static async changePassword(req: Request, res: Response) {
    const { currentPassword, newPassword } = req.body;

    const { error, value } = changePasswordSchema.validate({ currentPassword, newPassword });
    if (error) throw new HttpError(error.message, 400);

    await UsersSvc.changePassword(req.user.userId, value.currentPassword, value.newPassword);
    return res.status(200).json({ message: "Password updated successfully" });
  }

  static async deleteMe(req: Request, res: Response) {
    const { error, value } = deleteMeSchema.validate({ password: req.body?.password });
    if (error) throw new HttpError(error.message, 400);

    const user = await UsersSvc.requestDeletion(req.user.userId, value.password);
    // requestDeletion revoked every session; drop this browser's now-dead refresh cookie too.
    clearRefreshTokenCookie(res);
    return res.status(200).json(user);
  }

  /** POST /api/users/me/export — everything we hold about the caller, as one ZIP download:
   * data.json (the complete record), files/ (their uploaded files) and README.pdf (a readable
   * summary). A POST (not a GET) so the password can travel in the body, not the URL. */
  static async exportMe(req: Request, res: Response) {
    const { error, value } = deleteMeSchema.validate({ password: req.body?.password });
    if (error) throw new HttpError(error.message, 400);
    await UsersSvc.confirmPassword(req.user.userId, value.password);

    const result = await sendExportZip(res, req.user.userId);
    if (result) {
      await SecurityAuditSvc.record({
        action: "export.my_data",
        actorId: req.user.userId,
        targetType: "user",
        targetId: req.user.userId,
        payload: exportAuditPayload(result),
      });
    }
  }

  static async cancelDeletion(req: Request, res: Response) {
    const user = await UsersSvc.cancelDeletion(req.user.userId);
    return res.status(200).json(user);
  }

  static async uploadAvatar(req: Request, res: Response) {
    if (!req.file) throw new HttpError("No image uploaded (multipart field \"avatar\")", 400);
    const user = await AvatarSvc.setAvatar(req.user.userId, req.file.buffer);
    return res.status(200).json(user);
  }

  static async removeAvatar(req: Request, res: Response) {
    const user = await AvatarSvc.removeAvatar(req.user.userId);
    return res.status(200).json(user);
  }

  static async connectGoogleCalendar(req: Request, res: Response) {
    const { error, value } = connectGoogleCalendarSchema.validate({ code: req.body?.code });
    if (error) throw new HttpError(error.message, 400);

    const user = await GoogleCalendarSvc.connect(req.user.userId, value.code);
    return res.status(200).json(user);
  }

  static async disconnectGoogleCalendar(req: Request, res: Response) {
    const user = await GoogleCalendarSvc.disconnect(req.user.userId);
    return res.status(200).json(user);
  }

  /** GET /api/users/me/tour/:track — where the caller is in that onboarding tour. */
  static async getTour(req: Request, res: Response) {
    const track = tourTrack(req.params.track);
    const result = await ProductTourSvc.get(req.user.userId, track);
    return res.status(200).json(result);
  }

  /** PUT /api/users/me/tour/:track — saves the caller's whole tour state after a move. */
  static async saveTour(req: Request, res: Response) {
    const track = tourTrack(req.params.track);
    const { error, value } = saveProductTourSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await ProductTourSvc.save(req.user.userId, track, value);
    return res.status(200).json(result);
  }
}

function tourTrack(track: string) {
  if (!(PRODUCT_TOUR_TRACKS as readonly string[]).includes(track)) throw new HttpError(`Unknown tour: ${track}`, 404);
  return track;
}
