import { isEmail } from "@shared/validators/EmailValidator";
import { UserRepository } from "./UserRepository";

export class UserService {
  constructor(private readonly repo = new UserRepository()) {}

  register(id: string, email: string) {
    if (!isEmail(email)) throw new Error("invalid email");
    this.repo.save(id, { email });
    return this.repo.find(id);
  }
}
