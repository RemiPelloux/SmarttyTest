/**
 * Plugin SDK v1 edge providers: a plugin edge makes a targeted change select only the affected
 * tests, what a provider cannot resolve is uncertainty, and a broken provider never means
 * "no edges".
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { assertConformance, checkPlugin } from "@smarttest/plugin-sdk/conformance";
import type { SmartTestPlugin } from "@smarttest/shared";
import { main } from "smarttest";
import { describe, expect, it } from "vitest";
import { edit, FIXTURES, git, materialize } from "./helpers.js";

const FIXTURE = "plugin-edges-vitest";

async function selected(dir: string, options: { configPath?: string; mode?: "fast" } = {}) {
  const st = await SmartTest.open({
    root: dir,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const a = await st.analyze(options.mode ? { mode: options.mode } : {});
  return {
    tests: a.decision.selectedTests.map((t) => t.filePath).sort(),
    decision: a.decision,
    graph: a.graph,
  };
}

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  const io = {
    stdout: {
      write: (s: string) => {
        out += s;
        return true;
      },
      isTTY: false,
    },
    stderr: { write: () => true, isTTY: false },
  };
  const code = await main([...argv, "--json"], io as never, cwd);
  return { code, doc: JSON.parse(out) };
}

describe("edge-provider plugins", () => {
  it("a change to a file only a plugin edge reaches selects only the tests that read it", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(dir, "sql/find-user.sql", "id = ?", "email = ?");
    const r = await selected(dir);
    expect(r.tests).toEqual(["tests/users.test.ts"]);
    expect(r.decision.selectedTests[0]?.reasons[0]?.path).toEqual([
      "sql/find-user.sql",
      "src/users.ts",
      "tests/users.test.ts",
    ]);
    expect(r.graph.toGraph().edges).toContainEqual({
      from: "src/users.ts",
      to: "sql/find-user.sql",
      kind: "REFERENCES",
      provenance: "plugin",
      confidence: "high",
    });
  }, 120_000);

  it("without the plugin the same change reaches no test (the edge is what selects)", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(dir, "sql/find-user.sql", "id = ?", "email = ?");
    const bare = join(await mkdtemp(join(tmpdir(), "st-noplugin-")), "smarttest.config.json");
    await writeFile(bare, "{}");
    expect((await selected(dir, { configPath: bare })).tests).toEqual([]);
  }, 120_000);

  it("code changes still select through static analysis next to plugin edges", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(dir, "src/orders.ts", "rows.length;", "rows.length + 1;");
    expect((await selected(dir)).tests).toEqual(["tests/orders.test.ts"]);
  }, 120_000);

  it("unresolved relationships are uncertainty: their tests are never ruled out", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await writeFile(
      join(dir, "src/report.ts"),
      'import { query } from "./db.js";\nexport const report = (kind: string) => query(kind);\n',
    );
    await writeFile(
      join(dir, "tests/report.test.ts"),
      'import { expect, it } from "vitest";\nimport { report } from "../src/report.js";\nit("reports", () => expect(() => report("x")).toThrow());\n',
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "report");
    await edit(dir, "sql/list-orders.sql", "DESC", "ASC");
    const balanced = await selected(dir);
    expect(balanced.tests).toEqual(["tests/orders.test.ts", "tests/report.test.ts"]);
    expect(
      balanced.decision.selectedTests.find((t) => t.filePath === "tests/report.test.ts")?.reasons,
    ).toContainEqual(expect.objectContaining({ kind: "uncertainty" }));
    const fast = await selected(dir, { mode: "fast" });
    expect(fast.tests).toEqual(["tests/orders.test.ts"]);
    expect(fast.decision.warnings.join("\n")).toMatch(/FAST mode: 1 test\(s\) with unresolved/);
  }, 120_000);

  it("a change to the plugin module itself widens to the full suite", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(dir, "tools/sql-edges.mjs", "sql-queries", "sql-queries-v2");
    expect((await selected(dir)).tests).toEqual([
      "tests/db.test.ts",
      "tests/orders.test.ts",
      "tests/users.test.ts",
    ]);
  }, 120_000);

  it("a long-lived instance (watch, Studio) loads an edited plugin, never the old version", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    const st = await SmartTest.open({ root: dir });
    st.keepWarm = true;
    await st.analyze();
    expect((await st.plugins()).map((p) => p.plugin.name)).toEqual(["sql-edges"]);
    // The new plugin version links orders.ts to find-user.sql too; commit it so that the next
    // change set is only the SQL file (the plugin change alone would widen to everything).
    await edit(
      dir,
      "tools/sql-edges.mjs",
      "return { edges, unresolved };",
      'edges.push({ from: "src/orders.ts", to: "sql/find-user.sql", kind: "REFERENCES", confidence: "high" });\n    return { edges, unresolved };',
    );
    git(dir, "commit", "-qam", "plugin v2");
    await edit(dir, "sql/find-user.sql", "id = ?", "email = ?");
    const a = await st.analyze();
    expect(a.decision.selectedTests.map((t) => t.filePath).sort()).toEqual([
      "tests/orders.test.ts",
      "tests/users.test.ts",
    ]);
  }, 120_000);

  it("a provider that throws or returns invalid edges fails the run (exit 4), never 'no edges'", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(dir, "sql/find-user.sql", "id = ?", "email = ?");
    await edit(
      dir,
      "tools/sql-edges.mjs",
      "const all = new Set",
      'throw new Error("boom");\n    const all = new Set',
    );
    const thrown = await cli(dir, "impact");
    expect(thrown.code).toBe(4);
    expect(thrown.doc.error).toMatchObject({
      code: "ST_PLUGIN_FAILED",
      category: "infrastructure",
    });

    const dir2 = await materialize(FIXTURE, { git: true });
    await edit(dir2, "tools/sql-edges.mjs", "{ from: file, to,", '{ from: "/abs/" + file, to,');
    const invalid = await cli(dir2, "impact");
    expect(invalid.code).toBe(4);
    expect(invalid.doc.error.code).toBe("ST_PLUGIN_FAILED");
  }, 120_000);

  it("a plugin for another API version is a configuration error (exit 3)", async () => {
    const dir = await materialize(FIXTURE, { git: true });
    await edit(
      dir,
      "tools/sql-edges.mjs",
      "export default { apiVersion: 1",
      "export default { apiVersion: 2",
    );
    const r = await cli(dir, "impact");
    expect(r.code).toBe(3);
    expect(r.doc.error.code).toBe("ST_PLUGIN_API_VERSION");
  }, 120_000);

  it("the fixture plugin passes the conformance kit", async () => {
    const root = join(FIXTURES, FIXTURE);
    const plugin = (await import(join(root, "tools/sql-edges.mjs"))).default as SmartTestPlugin;
    const report = await checkPlugin(plugin, {
      edgeProviders: {
        "sql-queries": {
          root,
          files: ["src/db.ts", "src/orders.ts", "src/users.ts", "tests/users.test.ts"],
          allFiles: [
            "src/db.ts",
            "src/orders.ts",
            "src/users.ts",
            "sql/find-user.sql",
            "sql/list-orders.sql",
          ],
          expectedEdges: [
            { from: "src/users.ts", to: "sql/find-user.sql" },
            { from: "src/orders.ts", to: "sql/list-orders.sql" },
          ],
        },
      },
    });
    assertConformance(report);
    expect(report.checks.filter((c) => c.status === "pass").length).toBeGreaterThan(5);
  });
});
