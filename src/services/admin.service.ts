import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";

export default class AdminSvc {
  static async listUsers() {
    return AuthRepo.listAllUsers();
  }

  static async approve(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);

    const updated = await AuthRepo.setApprovalStatus(userId, "APPROVED", null);

    const html = await renderTemplate("signup-approved", { name: user.name || "there" });
    await sendEmail({ to: user.email, subject: "Your ilovelawyer account has been approved", html });

    return updated;
  }

  static async deny(userId: string, reason?: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);

    const updated = await AuthRepo.setApprovalStatus(userId, "DENIED", reason ?? null);

    const html = await renderTemplate("signup-denied", { name: user.name || "there", reason: reason ?? "" });
    await sendEmail({ to: user.email, subject: "Your ilovelawyer signup", html });

    return updated;
  }
}
