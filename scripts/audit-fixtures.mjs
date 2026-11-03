#!/usr/bin/env node
/**
 * Runs `smarttest audit` (fault injection, import resolution, reachability) on every fixture of
 * the regression harness whose runners need no browser, each in a temporary Git repository.
 * Exits 1 when any audit finds a missed test, an unreachable file or a mismatched import.
 * Used by the nightly audit workflow; `node scripts/audit-fixtures.mjs [fixture…]` runs it locally.
 *
 * Environment: AUDIT_MUTANTS (default 20 per fixture), AUDIT_SEED (default 1).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(repo, "fixtures", "projects");
const cli = join(repo, "packages", "cli", "dist", "bin.js");
const NO_BROWSER = new Set(["vitest", "jest", "node"]);
const mutants = process.env.AUDIT_MUTANTS ?? "20";
const seed = process.env.AUDIT_SEED ?? "1";

const wanted = process.argv.slice(2);
const names = readdirSync(fixtures).filter((name) => {
  const expected = join(fixtures, name, "expected.json");
  if (!existsSync(expected)) return false;
  if (wanted.length) return wanted.includes(name);
  const { runners = [] } = JSON.parse(readFileSync(expected, "utf8"));
  return runners.length > 0 && runners.every((r) => NO_BROWSER.has(r));
});

/** A copy outside the repository with its own Git history and the fixture's installed packages. */
function materialize(name) {
  const dir = mkdtempSync(join(tmpdir(), `st-audit-${name}-`));
  cpSync(join(fixtures, name), dir, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes(".smarttest"),
  });
  const link = (src, dest) => {
    if (existsSync(src) && !existsSync(dest)) symlinkSync(src, dest, "junction");
  };
  link(join(fixtures, name, "node_modules"), join(dir, "node_modules"));
  // Workspace packages of a monorepo fixture keep their own node_modules.
  for (const sub of ["packages", "apps"])
    if (existsSync(join(fixtures, name, sub)))
      for (const p of readdirSync(join(fixtures, name, sub)))
        link(join(fixtures, name, sub, p, "node_modules"), join(dir, sub, p, "node_modules"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=audit",
        "-c",
        "user.email=audit@smarttest.dev",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: dir,
        stdio: "ignore",
      },
    );
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

let failed = 0;
const summary = [];
for (const name of names) {
  const dir = materialize(name);
  try {
    const res = spawnSync(
      process.execPath,
      [
        cli,
        "audit",
        "--mutate",
        "--mutants",
        mutants,
        "--seed",
        seed,
        "--resolution",
        "--traces",
        "--json",
      ],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      report = undefined;
    }
    const m = report?.mutate;
    const line = report
      ? `${name}: ${m?.mutants.length ?? 0}/${m?.functions ?? 0} functions, missed ${m?.missed ?? "?"}, survived ${m?.survived ?? "?"} · unreachable ${report.traces?.unreachable.length ?? "?"} · import mismatches ${report.resolution?.mismatches.length ?? "?"}`
      : `${name}: audit did not report (exit ${res.status}): ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ")}`;
    console.log(line);
    summary.push(line);
    if (res.status !== 0) {
      failed++;
      for (const x of m?.mutants ?? [])
        if (x.missed.length)
          console.log(`  missed: ${x.file}#${x.function} → ${x.missed.join(", ")}`);
      for (const u of report?.traces?.unreachable ?? [])
        console.log(`  unreachable: ${u.test} loaded ${u.file}`);
      for (const x of report?.resolution?.mismatches ?? [])
        console.log(
          `  mismatch: ${x.file} imports ${x.specifier}: SmartTest ${x.smarttest}, compiler ${x.typescript}`,
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## SmartTest audit of the fixtures\n\n${summary.map((s) => `- ${s}`).join("\n")}\n`,
    { flag: "a" },
  );
console.log(`\n${names.length - failed}/${names.length} fixtures audited without a miss`);
process.exit(failed ? 1 : 0);
