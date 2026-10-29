import { readFileSync } from "node:fs";
import { join } from "node:path";

export function welcome(name: string): string {
  return readFileSync(join(import.meta.dirname, "..", "templates", "welcome.txt"), "utf8").replace("{name}", name).trim();
}

export function goodbye(name: string): string {
  return readFileSync(join(import.meta.dirname, "../templates/goodbye.txt"), "utf8").replace("{name}", name).trim();
}
