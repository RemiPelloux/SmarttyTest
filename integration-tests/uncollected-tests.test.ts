import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

/**
 * A selected test that no runner executes must never let a run pass (AGENTS.md: never report a
 * skipped test as passed). The run fails with the infrastructure exit code (4) and names the file
 * and the cause.
 */
describe("selected tests that no runner executes", () => {
  const bin = resolve(import.meta.dirname, "../packages/cli/dist/bin.js");

  /** next-playwright plus lib/cart.js and its unit test, committed. */
  async function setup(extra: Record<string, string>): Promise<string> {
    const dir = await materialize("next-playwright", { git: true });
    await writeFile(
      join(dir, "lib/cart.js"),
      "export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n",
    );
    await writeFile(
      join(dir, "test/cart.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { total } from "../lib/cart.js";',
        "",
        'test("total", () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));',
        "",
      ].join("\n"),
    );
    for (const [file, text] of Object.entries(extra)) await writeFile(join(dir, file), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "cart");
    // The change: only cart's tests (and anything uncertain) are affected.
    await edit(dir, "lib/cart.js", "export function total", "// changed\nexport function total");
    return dir;
  }

  const run = (dir: string, ...args: string[]) =>
    spawnSync(process.execPath, [bin, "run", "--uncommitted", "--no-cache", ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  it("fails a run when a Playwright spec with a missing static import breaks the listing", async () => {
    const dir = await setup({
      "e2e/checkout.spec.js": [
        'import { expect, test } from "@playwright/test";',
        'import { total } from "../lib/cart.js";',
        'import { seedCart } from "../support/seed-cart.js";',
        "",
        'test("checkout", async ({ request }) => {',
        "  await seedCart(request);",
        "  expect(total([])).toBe(0);",
        "});",
        "",
      ].join("\n"),
    });
    const r = run(dir);
    const output = `${r.stdout}\n${r.stderr}`;
    // Exit 4 (infrastructure failure): never 0, never a pass by omission. A report integrity
    // violation would exit 70 instead.
    expect(r.status, output).toBe(4);
    expect(output).toContain("e2e/checkout.spec.js");
    expect(output).toContain("playwright (.) discovery failed");
    expect(output).toContain("seed-cart");
    // The unit test still ran under its own runner: a broken listing does not take it away.
    expect(output).toContain("test/cart.test.js");

    const report = JSON.parse(await readFile(join(dir, ".smarttest/runs/latest.json"), "utf8"));
    const selected = report.decision.selectedTests.map((t: { filePath: string }) => t.filePath);
    expect(selected).toContain("e2e/checkout.spec.js");
    const spec = report.executions.find((e: { file: string }) => e.file === "e2e/checkout.spec.js");
    expect(spec?.status).toBe("infrastructure-error");
    const unit = report.executions.find((e: { file: string }) => e.file === "test/cart.test.js");
    expect(unit).toMatchObject({ adapter: "node", status: "passed" });
    expect(report.summary.infrastructureErrors).toBeGreaterThan(0);

    // The broken listing is not cached as the truth: the next run reports it again.
    const again = run(dir);
    expect(again.status).toBe(4);
    expect(`${again.stdout}\n${again.stderr}`).toContain("discovery failed");
  }, 180_000);

  it("fails a run when a selected test file is collected by no runner", async () => {
    // node --test collects test/ only and Playwright collects e2e/: nothing runs this file.
    const dir = await setup({
      "lib/cart.extra.test.js": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { total } from "./cart.js";',
        "",
        'test("empty", () => assert.equal(total([]), 0));',
        "",
      ].join("\n"),
    });
    const r = run(dir, "--json");
    expect(r.status, r.stderr).toBe(4);
    const json = JSON.parse(r.stdout);
    const orphan = json.report.executions.find(
      (e: { file: string }) => e.file === "lib/cart.extra.test.js",
    );
    expect(orphan).toMatchObject({ status: "infrastructure-error", adapter: "none", tests: [] });
    expect(orphan.error).toContain("no runner collects this file");
    expect(json.report.summary.passed).toBeGreaterThan(0);
    expect(json.report.warnings.join("\n")).toContain("no runner collects them");
  }, 180_000);
});
