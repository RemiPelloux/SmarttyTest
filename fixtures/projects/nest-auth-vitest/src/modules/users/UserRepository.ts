export interface UserRecord {
  email: string;
}

export class UserRepository {
  private readonly users = new Map<string, UserRecord>();

  save(id: string, user: UserRecord): void {
    this.users.set(id, user);
  }

  find(id: string): UserRecord | undefined {
    return this.users.get(id);
  }
}
