/**
 * Regressions from the 1.0.0 user-level audit: dry runs that wrote state, a committed store that
 * nothing could repair, `explain` reporting a stale decision, plugin errors, rollback and
 * uninstall touching the wrong hooks, and output piped to a reader that goes away.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "smarttest";
import { afterEach, describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(name = "ts-lib-vitest"): Promise<string> {
  const dir = await materialize(name, { git: true });
  dirs.push(dir);
  return dir;
}

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    } as never,
    cwd,
  );
  return { code, out, err };
}

describe("init --dry-run", () => {
  it("writes nothing to the project, not even its state", async () => {
    const dir = await project();
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    git(dir, "commit", "-qam", "no store entry");
    const before = await readdir(dir);
    const r = await cli(dir, "init", "--dry-run");
    expect(r.code).toBe(0);
    expect(await readdir(dir)).toEqual(before);
    expect(existsSync(join(dir, ".smarttest"))).toBe(false);
    expect(git(dir, "status", "--porcelain")).toBe("");
  }, 120_000);
});

describe("a store committed to the repository", () => {
  async function committedStore() {
    const dir = await project();
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await mkdir(join(dir, ".smarttest", "state"), { recursive: true });
    await writeFile(join(dir, ".smarttest", "state", "index.json"), "{}");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "commit the store by mistake");
    return dir;
  }

  it("doctor reports it (exit 3) and --fix ignores it and gives the exact command", async () => {
    const dir = await committedStore();
    const doctor = await cli(dir, "doctor");
    expect(doctor.code).toBe(3);
    expect(doctor.out).toMatch(/store\s+\.smarttest\/ is committed/);
    const fix = await cli(dir, "doctor", "--fix");
    expect(fix.out).toContain("git rm -r --cached .smarttest");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".smarttest/\n");
    // Never run without approval: the store is still tracked.
    expect(git(dir, "ls-files", ".smarttest")).not.toBe("");
    expect(fix.code).toBe(3);
  }, 120_000);

  it("init --yes ignores it and stops with the command; after it, init and run work", async () => {
    const dir = await committedStore();
    const init = await cli(dir, "init", "--yes");
    expect(init.code).toBe(3);
    expect(init.err).toContain("ST_STORE_TRACKED");
    expect(init.out).toContain("git rm -r --cached .smarttest");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".smarttest/");
    git(dir, "rm", "-r", "-q", "--cached", ".smarttest");
    expect((await cli(dir, "init", "--yes")).code).toBe(0);
    expect((await cli(dir, "impact")).code).toBe(0);
  }, 120_000);
});

describe("explain", () => {
  it("analyses again when the change or the mode moved since the last decision", async () => {
    const dir = await project();
    await edit(dir, "src/util/numbers.ts", "Math.min(max", "Math.max(max");
    expect((await cli(dir, "impact", "--mode", "fast")).code).toBe(0);
    await edit(dir, "src/util/strings.ts", '"$1-$2"', '"$1_$2"');
    const r = JSON.parse((await cli(dir, "explain", "test/strings.test.ts", "--json")).out);
    expect(r.status).toBe("selected");
    expect(r.mode).toBe("balanced");
    expect(r.description).toContain("fresh analysis");
    // Unchanged since that analysis: its decision is reused and says when it was made.
    const again = JSON.parse((await cli(dir, "explain", "test/strings.test.ts", "--json")).out);
    expect(again.status).toBe("selected");
    expect(again.description).toContain("decision of the run at");
  }, 120_000);
});

describe("plugins", () => {
  it("a missing plugin file is a configuration error (exit 3) that names the file", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "smarttest.config.ts"),
      'export default { plugins: ["./tools/sql-edges.mjs"] };\n',
    );
    const doctor = await cli(dir, "doctor");
    expect(doctor.code).toBe(3);
    expect(doctor.out).toContain("file not found: tools/sql-edges.mjs");
    const run = await cli(dir, "impact");
    expect(run.code).toBe(3);
    expect(run.err).toContain("file not found: tools/sql-edges.mjs");
  }, 120_000);
});

describe("init --rollback and uninstall", () => {
  const hook = (dir: string, stage: string) =>
    resolve(dir, git(dir, "rev-parse", "--git-path", `hooks/${stage}`).trim());

  it("rollback undoes init's steps only: a hook installed later stays", async () => {
    const dir = await project();
    expect((await cli(dir, "init", "--yes")).code).toBe(0);
    expect((await cli(dir, "hook", "install", "--pre-push", "--yes")).code).toBe(0);
    expect(await readFile(hook(dir, "pre-push"), "utf8")).toContain("smarttest");
    expect((await cli(dir, "init", "--rollback")).code).toBe(0);
    expect(await readFile(hook(dir, "pre-push"), "utf8")).toContain("smarttest");
    expect(existsSync(hook(dir, "pre-commit"))).toBe(false);
  }, 120_000);

  it("rollback with an edited file undoes the rest, exits 5 and finishes later", async () => {
    const dir = await project();
    await cli(dir, "init", "--yes");
    await writeFile(join(dir, "smarttest.config.ts"), "export default {};\n");
    const r = await cli(dir, "init", "--rollback");
    expect(r.code).toBe(5);
    expect(r.out).toContain("left as they are");
    expect(existsSync(hook(dir, "pre-commit"))).toBe(false);
    await rm(join(dir, "smarttest.config.ts"));
    const again = await cli(dir, "init", "--rollback");
    expect(again.out).not.toContain("edited since init");
  }, 120_000);

  it("uninstall removes SmartTest's hook blocks and says which files it only edited", async () => {
    const dir = await project();
    await cli(dir, "init", "--yes");
    await cli(dir, "hook", "install", "--pre-push", "--yes");
    const r = await cli(dir, "uninstall", "--yes");
    expect(r.code).toBe(0);
    for (const stage of ["pre-commit", "pre-push"])
      expect(await readFile(hook(dir, stage), "utf8").catch(() => "")).not.toContain("smarttest");
    expect(r.out).toContain("edited .gitignore");
    expect(r.out).not.toContain("removed .gitignore");
    expect(r.out).not.toContain("removed package.json");
  }, 120_000);
});

describe("output piped to a reader that goes away", () => {
  it("exits quietly with the command's own code, without an EPIPE stack", async () => {
    const dir = await project();
    const bin = resolve(import.meta.dirname, "../packages/cli/dist/bin.js");
    const child = spawn(process.execPath, [bin, "impact", "--json"], { cwd: dir });
    child.stdout.destroy();
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(err).not.toContain("EPIPE");
    expect(code).toBe(0);
  }, 120_000);
});
