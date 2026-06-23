import bcrypt from "bcrypt";
import LoginRepo from "../repositories/login.repository";
import loginToken from "../utils/loginToken";
import { REFRESH_TOKEN_EXPIRY_DAYS } from "../config";
import HttpError from "../utils/http-error";

export default class LoginSvc {
  static async login(email: string, password: string) {
    const user = await LoginRepo.findByEmail(email);
    if (!user || !user.password) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new HttpError("Invalid email or password", 401);
    }

    const { accessToken, refreshToken } = loginToken(user.id);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await LoginRepo.createSession(user.id, refreshToken, expiresAt);
    await LoginRepo.updateLastLogin(user.id);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      accessToken,
      refreshToken,
    };
  }
}
