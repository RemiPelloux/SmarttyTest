import { isEmail } from "@shared/validators/EmailValidator";
import { TokenManager } from "./TokenManager";

export class AuthService {
  constructor(private readonly tokens = new TokenManager()) {}

  validateToken(token: string): boolean {
    return this.tokens.verify(token);
  }

  login(email: string): string {
    if (!isEmail(email)) throw new Error("invalid email");
    return this.tokens.issue(email.split("@")[0] ?? "");
  }
}
