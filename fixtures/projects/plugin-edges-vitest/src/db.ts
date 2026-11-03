import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Loads a named SQL query from sql/<name>.sql, relative to where the process runs. */
export function query(name: string): string {
  return readFileSync(join(process.env.SQL_DIR ?? process.cwd(), "sql", `${name}.sql`), "utf8").trim();
}
