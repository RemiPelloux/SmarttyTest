/**
 * `smarttest sync` as an upgrade assistant: proposals shown as diffs, nothing written without
 * --apply (or an accepted prompt), and an accepted change written atomically.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type JsonSchema, validateJsonSchema } from "@smarttest/shared";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { materialize } from "./helpers.js";

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    },
    cwd,
  );
  return { code, out, err };
}

const SCHEMA = resolve(import.meta.dirname, "../packages/cli/schemas/sync.v1.schema.json");

const OLD_BLOCK = `#!/bin/sh
# >>> smarttest >>>
npx --no-install smarttest run --staged || exit 1
# <<< smarttest <<<
`;

describe("smarttest sync: upgrade proposals", () => {
  it("shows each proposal as a diff, writes nothing without --apply, then writes atomically", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const config = join(dir, "smarttest.config.json");
    const configText = `${JSON.stringify({ triggers: ["**/yarn.lock", "db/schema.sql"] }, null, 2)}\n`;
    await writeFile(config, configText);
    const hook = join(dir, ".git/hooks/pre-commit");
    await writeFile(hook, OLD_BLOCK, { mode: 0o755 });
    const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as JsonSchema;

    const dry = await cli(dir, "sync", "--dry-run", "--json");
    expect(dry.code).toBe(0);
    const doc = JSON.parse(dry.out);
    expect(validateJsonSchema(schema, doc)).toEqual([]);
    const keys = doc.upgrades.map((u: { key: string }) => u.key);
    expect(keys).toEqual(expect.arrayContaining(["redundant-triggers", "hook-block:pre-commit"]));
    const hookUp = doc.upgrades.find((u: { key: string }) => u.key === "hook-block:pre-commit");
    expect(hookUp.diff.join("\n")).toContain("--staged --hook");
    // The human output carries the same diffs.
    const human = await cli(dir, "sync", "--dry-run");
    expect(human.out).toContain("Upgrade proposals");
    expect(human.out).toContain("Dry run — nothing was written.");

    // Without --apply and without a terminal: nothing written, exit 3 (frozen contract).
    const refused = await cli(dir, "sync");
    expect(refused.code).toBe(3);
    // `--check` is about drift only: upgrade proposals never fail it.
    expect((await cli(dir, "sync", "--check")).code).toBe(0);
    expect(await readFile(config, "utf8")).toBe(configText);
    expect(await readFile(hook, "utf8")).toBe(OLD_BLOCK);

    const applied = await cli(dir, "sync", "--apply", "--json");
    expect(applied.code).toBe(0);
    const appliedDoc = JSON.parse(applied.out);
    expect(validateJsonSchema(schema, appliedDoc)).toEqual([]);
    expect(appliedDoc.applied).toHaveLength(2);
    expect(JSON.parse(await readFile(config, "utf8")).triggers).toEqual(["db/schema.sql"]);
    expect(await readFile(hook, "utf8")).toContain(
      "npx --no-install smarttest run --staged --hook",
    );

    const again = JSON.parse((await cli(dir, "sync", "--dry-run", "--json")).out);
    expect(again.upgrades).toEqual([]);
  }, 120_000);

  it("leaves a config edited after the proposal as it is", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const config = join(dir, "smarttest.config.json");
    await writeFile(config, `${JSON.stringify({ triggers: ["**/yarn.lock"] }, null, 2)}\n`);
    const { SmartTest, applyUpgrades, planUpgrades } = await import("@smarttest/core");
    const st = await SmartTest.open({ root: dir });
    const plan = await planUpgrades(st);
    expect(plan.proposals.map((p) => p.key)).toContain("redundant-triggers");
    const edited = `${JSON.stringify({ triggers: ["**/yarn.lock"], mode: "safe" }, null, 2)}\n`;
    await writeFile(config, edited);
    const res = await applyUpgrades(st, await st.syncPlan(), plan, new Set(["redundant-triggers"]));
    expect(res.applied).toEqual([]);
    expect(res.skipped[0]?.why).toMatch(/changed since the proposal/);
    expect(await readFile(config, "utf8")).toBe(edited);
  }, 120_000);
});
