/**
 * The commit trailer (S34, `hook.trailer`): a real `git commit` through a pre-commit hook that runs
 * SmartTest and a commit-msg hook that runs `smarttest hook trailer "$1"`. The message gets
 * `Tests: …` only when a passing pre-commit record matches the committed tree.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const bin = resolve(import.meta.dirname, "../packages/cli/dist/bin.js");

async function cli(root: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    args,
    {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    },
    root,
  );
  return { code, out, err };
}

/** A fixture with SmartTest in its pre-commit and commit-msg hooks, and `hook.trailer` set. */
async function setup(trailer: boolean): Promise<string> {
  const dir = await materialize("ts-lib-vitest", { git: true });
  await writeFile(join(dir, "smarttest.config.json"), `${JSON.stringify({ hook: { trailer } })}\n`);
  git(dir, "add", "smarttest.config.json");
  git(dir, "commit", "-qm", "config");
  const hooks = join(dir, ".git/hooks");
  await mkdir(hooks, { recursive: true });
  const node = JSON.stringify(process.execPath);
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\n${node} ${JSON.stringify(bin)} run --staged --hook --no-cache --quiet || exit 1\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(hooks, "commit-msg"),
    `#!/bin/sh\n${node} ${JSON.stringify(bin)} hook trailer "$1" || true\n`,
    { mode: 0o755 },
  );
  git(dir, "config", "core.hooksPath", hooks);
  return dir;
}

function commit(dir: string, message: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    "git",
    [
      "-c",
      "user.name=SmartTest",
      "-c",
      "user.email=ci@smarttest.dev",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir, encoding: "utf8", env },
  );
}

const lastMessage = (dir: string) => git(dir, "log", "-1", "--format=%B").trim();

async function stageChange(dir: string, marker: string) {
  await edit(dir, "src/util/numbers.ts", "PRECISION = 2", `PRECISION = 2; // ${marker}`);
  git(dir, "add", "src/util/numbers.ts");
}

describe("commit trailer", () => {
  it("adds Tests: from the pre-commit run of the committed tree", async () => {
    const dir = await setup(true);
    await stageChange(dir, "first");
    const res = commit(dir, "feat: change math");
    expect(res.status, res.stderr).toBe(0);
    const message = lastMessage(dir);
    expect(message).toMatch(/^feat: change math\n\nTests: \d+ run, \d+ not run/);
    // A Git trailer: `git interpret-trailers --parse` reads it back.
    const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
      input: `${message}\n`,
      encoding: "utf8",
    }).stdout;
    expect(parsed).toMatch(/^Tests: \d+ run, \d+ not run/);
    const records = JSON.parse(await readFile(join(dir, ".smarttest/state/hooks.json"), "utf8"));
    const last = records.runs.at(-1);
    expect(last).toMatchObject({ stage: "pre-commit", passed: true });
    expect(message).toContain(`Tests: ${last.executed} run, ${last.notRun} not run`);
  }, 180_000);

  it("adds nothing when the hook was bypassed (no record for the tree)", async () => {
    const dir = await setup(true);
    await stageChange(dir, "bypassed");
    const res = commit(dir, "fix: bypass", { ...process.env, SMARTTEST_SKIP: "1" });
    expect(res.status, res.stderr).toBe(0);
    expect(lastMessage(dir)).toBe("fix: bypass");
  }, 180_000);

  it("adds nothing when hook.trailer is off", async () => {
    const dir = await setup(false);
    await stageChange(dir, "off");
    const res = commit(dir, "chore: no trailer");
    expect(res.status, res.stderr).toBe(0);
    expect(lastMessage(dir)).toBe("chore: no trailer");
  }, 180_000);

  it("hook trailer never fails: a missing record or message file exits 0 and writes nothing", async () => {
    const dir = await setup(true);
    await writeFile(join(dir, "MSG"), "docs: nothing staged was tested\n");
    expect((await cli(dir, "hook", "trailer", "MSG")).code).toBe(0);
    expect(await readFile(join(dir, "MSG"), "utf8")).toBe("docs: nothing staged was tested\n");
    expect((await cli(dir, "hook", "trailer", "missing-file")).code).toBe(0);
  }, 60_000);

  it("hook install plans the commit-msg step when hook.trailer is on", async () => {
    const dir = await setup(true);
    git(dir, "config", "--unset", "core.hooksPath");
    const plan = await cli(dir, "hook", "install", "--dry-run", "--json");
    expect(plan.code).toBe(0);
    const json = JSON.parse(plan.out);
    expect(json.plan.trailer).toMatchObject({ manager: "git", installed: false });
    expect(json.plan.trailer.plan.after).toContain('smarttest hook trailer "$1" || true');
    const applied = await cli(dir, "hook", "install", "--yes", "--json");
    expect(JSON.parse(applied.out).applied).toEqual([
      ".git/hooks/pre-commit",
      ".git/hooks/commit-msg",
    ]);
    const removed = await cli(dir, "hook", "uninstall", "--yes", "--json");
    expect(JSON.parse(removed.out).removed.sort()).toEqual([
      ".git/hooks/commit-msg",
      ".git/hooks/pre-commit",
    ]);
  }, 60_000);
});
