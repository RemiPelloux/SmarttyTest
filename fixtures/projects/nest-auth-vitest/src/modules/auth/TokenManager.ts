export const TOKEN_PREFIX = "tok_";

export class TokenManager {
  verify(token: string): boolean {
    return token.startsWith(TOKEN_PREFIX) && token.length > 8;
  }

  issue(userId: string): string {
    return `${TOKEN_PREFIX}${userId}_${userId.length}`;
  }
}
