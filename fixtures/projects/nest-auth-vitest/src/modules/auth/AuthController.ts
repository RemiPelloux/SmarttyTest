import { AuthService } from "./AuthService";

export class AuthController {
  constructor(private readonly auth = new AuthService()) {}

  handleLogin(body: { email: string }): { token: string } {
    return { token: this.auth.login(body.email) };
  }
}
