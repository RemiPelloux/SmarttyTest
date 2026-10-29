import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTestCommands } from "./commands.js";

describe("detectTestCommands", () => {
  it("reads hooks (with cd context and continuations) and package scripts, ignoring echo lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "st-cmds-"));
    await mkdir(join(root, ".husky"));
    await mkdir(join(root, "backend"));
    await writeFile(
      join(root, ".husky/pre-commit"),
      [
        "#!/usr/bin/env bash",
        'echo "running fast jest suites..."',
        "cd backend",
        "if ! npx --no-install jest \\",
        "        --silent \\",
        "        --testPathIgnorePatterns=redisJobQueue \\",
        "        --bail; then exit 1; fi",
        'cd "$REPO_ROOT"',
        "cd mcp && node --test --test-timeout=15000",
      ].join("\n"),
    );
    await writeFile(
      join(root, "backend/package.json"),
      JSON.stringify({ scripts: { test: "jest", unit: "vitest run --exclude 'e2e/**'" } }),
    );
    const cmds = await detectTestCommands(root, ["backend"]);
    const hook = cmds.filter((c) => c.source === ".husky/pre-commit");
    expect(hook.map((c) => c.adapter)).toEqual(["jest", "node"]);
    expect(hook[0]).toMatchObject({
      dir: "backend",
      ignores: ["backend/**/*redisJobQueue*"],
      line: 4,
    });
    const unit = cmds.find((c) => c.source === "backend/package.json#scripts.unit");
    expect(unit?.ignores).toEqual(["backend/e2e/**"]);
  });
});
