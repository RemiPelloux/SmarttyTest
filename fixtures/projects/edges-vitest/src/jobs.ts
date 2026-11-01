import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Runs scripts/double.mjs in a child process. */
export function double(n: number): number {
  const script = fileURLToPath(new URL("../scripts/double.mjs", import.meta.url));
  return Number(execFileSync(process.execPath, [script, String(n)]).toString());
}
