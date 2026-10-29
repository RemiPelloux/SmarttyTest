import { authenticate } from "../modules/auth/AuthenticationMiddleware";

export function protectedRoute(headers: Record<string, string | undefined>): { status: number; body?: string } {
  if (!authenticate(headers)) return { status: 401 };
  return { status: 200, body: "secret" };
}
