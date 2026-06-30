import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";

export default class UsersSvc {
  static async getMe(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    return user;
  }
}
