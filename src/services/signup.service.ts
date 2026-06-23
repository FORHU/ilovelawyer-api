import SignupRepo from "../repositories/signup.repository";
import bcrypt from "bcrypt";
import HttpError from "../utils/http-error";

export default class SignupSvc {
 static async signup(username: string, email: string, password: string) {
  const existingUser = await SignupRepo.findByEmail(email);
  if (existingUser) {
    throw new HttpError("Email already in use", 409);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await SignupRepo.createUser(username, email, hashedPassword);
  return user;
}

}
