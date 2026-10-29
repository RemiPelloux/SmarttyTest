import { AuthService } from "./AuthService";

const auth = new AuthService();

export function authenticate(headers: Record<string, string | undefined>): boolean {
  const header = headers.authorization ?? "";
  return auth.validateToken(header.replace(/^Bearer /, ""));
}
