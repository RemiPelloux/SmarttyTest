import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { git, materialize } from "./helpers.js";

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

describe("hook CLI contract", () => {
  it("returns a failing exit code for project checks even with no selected tests", async () => {
    const root = await materialize("ts-lib-vitest", { git: true });
    await writeFile(
      join(root, "smarttest.config.json"),
      JSON.stringify({ hook: { checks: [{ name: "Policy", run: "exit 1" }] } }),
    );
    git(root, "add", "smarttest.config.json");
    git(root, "commit", "-qm", "hook policy");
    await writeFile(join(root, "notes.md"), "changed\n");
    git(root, "add", "notes.md");
    const result = await cli(root, "run", "--staged", "--hook", "--json");
    expect(result.code).toBe(1);
    const json = JSON.parse(result.out);
    expect(json.hook.checks[0].status).toBe("failed");
    expect(json.report.decision.selectedTests).toEqual([]);
    expect(json.report.summary.passed).toBe(0);
  }, 120000);

  it("rejects hook sharding and conflicting change sources", async () => {
    const root = await materialize("ts-lib-vitest", { git: true });
    for (const args of [
      ["--staged", "--push"],
      ["--staged", "--hook", "--shard", "1/2"],
      ["--all", "--hook"],
    ]) {
      const result = await cli(root, "run", ...args, "--json");
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out).error.code).toBe("ST_USAGE");
    }
  });

  it("previews and installs pre-push without changing the pre-commit stage", async () => {
    const root = await materialize("ts-lib-vitest", { git: true });
    const preview = await cli(root, "hook", "install", "--pre-push", "--dry-run", "--json");
    expect(preview.code).toBe(0);
    const install = await cli(root, "hook", "install", "--pre-push", "--yes", "--json");
    expect(install.code).toBe(0);
    const status = await cli(root, "hook", "status", "--pre-push", "--json");
    expect(status.code).toBe(0);
    expect(status.out).toContain('"installed": true');
    const precommit = await cli(root, "hook", "status", "--json");
    expect(precommit.out).toContain('"installed": false');
  });
});
