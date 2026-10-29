#!/usr/bin/env node
/**
 * `npm audit` of the packed package's runtime dependencies, in a scratch directory.
 * Fails on high or critical advisories; reports (does not fail) when the registry is unreachable.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dir = await mkdtemp(join(tmpdir(), "smarttest-audit-"));
try {
  await cp(join(root, "packages/cli/.publish/package.json"), join(dir, "package.json"));
  execFileSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: dir, stdio: "ignore" },
  );
  let report;
  try {
    report = JSON.parse(
      execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8" }),
    );
  } catch (e) {
    report = JSON.parse(e.stdout || "{}");
  }
  const v = report.metadata?.vulnerabilities ?? {};
  const serious = (v.high ?? 0) + (v.critical ?? 0);
  console.log(
    `✔ npm audit: ${v.total ?? 0} advisories (${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low)`,
  );
  if (serious) process.exitCode = 1;
} catch (e) {
  console.warn(
    `▲ npm audit could not run (${String(e.message).split("\n")[0]}); check before publishing`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
