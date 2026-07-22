import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";

export default class UsersSvc {
  static async getMe(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    return user;
  }

  static async updateMe(userId: string, data: { name?: string; username?: string }) {
    if (data.username) {
      const existing = await AuthRepo.findByUsername(data.username);
      if (existing && existing.id !== userId) {
        throw new HttpError("Username is already taken", 409);
      }
    }

    return AuthRepo.updateProfile(userId, data);
  }
}
