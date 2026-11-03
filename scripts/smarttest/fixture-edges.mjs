/**
 * SmartTest on SmartTest: links the integration tests to what static analysis cannot see.
 *
 * - A test names its fixtures with a string (`materialize("ts-lib-vitest")`, the regression
 *   harness's list): every file of `fixtures/projects/<name>/` is a dependency of that test.
 * - A test that starts the bundled CLI (`packages/cli/dist/bin.js`) runs every package: every
 *   source file under `packages/` is a dependency of it.
 */
const STRING = /["'`]([a-z0-9][a-z0-9-]*)["'`]/g;

/** @type {import("@tkmremi/smarttest/plugin-sdk").EdgeProvider} */
const fixtureEdges = {
  apiVersion: 1,
  id: "smarttest-fixtures",
  getCapabilities: () => ({ fileEdges: true, unresolved: true, nonSourceFiles: true }),
  async provideEdges(ctx) {
    const all = await ctx.listFiles();
    const byFixture = new Map();
    for (const f of all) {
      const m = /^fixtures\/projects\/([^/]+)\/(.+)$/.exec(f);
      if (!m || m[2].split("/").includes("node_modules")) continue;
      const list = byFixture.get(m[1]) ?? [];
      list.push(f);
      byFixture.set(m[1], list);
    }
    const sources = all.filter(
      (f) => /^packages\/[^/]+\/src\/.+\.ts$/.test(f) && !f.endsWith(".test.ts"),
    );
    const edges = [];
    for (const file of [...ctx.files].sort()) {
      if (!file.startsWith("integration-tests/")) continue;
      const text = (await ctx.readFile(file)) ?? "";
      const named = new Set();
      for (const m of text.matchAll(STRING)) if (byFixture.has(m[1])) named.add(m[1]);
      for (const name of named)
        for (const to of byFixture.get(name))
          edges.push({ from: file, to, kind: "REFERENCES", confidence: "high" });
      if (text.includes("packages/cli/dist/"))
        for (const to of sources)
          edges.push({ from: file, to, kind: "REFERENCES", confidence: "high" });
    }
    return { edges, unresolved: [] };
  },
};

/** @type {import("@tkmremi/smarttest/plugin-sdk").SmartTestPlugin} */
export default { apiVersion: 1, name: "smarttest-fixtures", edgeProviders: [fixtureEdges] };
