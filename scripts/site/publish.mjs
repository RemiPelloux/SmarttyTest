/**
 * Publishes site/dist to the gh-pages branch (GitHub Pages serves it from there; no workflow).
 *   node scripts/site/build.mjs && node scripts/site/publish.mjs
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
const remote = run("git", ["remote", "get-url", "origin"], ROOT);
const sha = run("git", ["rev-parse", "--short", "HEAD"], ROOT);
const dir = await mkdtemp(join(tmpdir(), "smarttest-pages-"));
try {
  await cp(join(ROOT, "site/dist"), dir, { recursive: true });
  run("git", ["init", "-q", "-b", "gh-pages"], dir);
  run("git", ["add", "-A"], dir);
  run(
    "git",
    [
      "-c",
      "user.name=SmartTest site",
      "-c",
      "user.email=site@smarttest.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      `site: build of ${sha}`,
    ],
    dir,
  );
  run("git", ["push", "-q", "--force", remote, "gh-pages"], dir);
  console.log(`published site/dist (from ${sha}) to gh-pages`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
