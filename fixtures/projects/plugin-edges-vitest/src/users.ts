import { query } from "./db.js";

export function findUserQuery(): string {
  return query("find-user");
}
