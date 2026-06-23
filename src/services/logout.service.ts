import LogoutRepo from "../repositories/logout.repository";

export default class LogoutSvc {
  static async logout(refreshToken: string) {
    await LogoutRepo.deleteByRefreshToken(refreshToken);
  }
}
