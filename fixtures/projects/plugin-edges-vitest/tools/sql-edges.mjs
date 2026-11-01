/**
 * A SmartTest plugin (Plugin SDK v1): `query("name")` reads sql/<name>.sql at run time, which
 * static analysis cannot see. This edge provider links each caller to the SQL file it reads.
 * A query name that is not a string literal, or that has no file, is reported as unresolved.
 */
const CALL = /\bquery\(\s*(?:"([\w-]+)"|'([\w-]+)'|([^)]*))\)/g;

/** @type {import("smarttest/plugin-sdk").EdgeProvider} */
const sqlEdges = {
  apiVersion: 1,
  id: "sql-queries",
  getCapabilities: () => ({ fileEdges: true, unresolved: true, nonSourceFiles: true }),
  async provideEdges(ctx) {
    const all = new Set(await ctx.listFiles());
    const edges = [];
    const unresolved = [];
    for (const file of [...ctx.files].sort()) {
      if (ctx.isTest(file) || !file.startsWith("src/") || file === "src/db.ts") continue;
      const text = (await ctx.readFile(file)) ?? "";
      for (const m of text.matchAll(CALL)) {
        const name = m[1] ?? m[2];
        if (!name) {
          unresolved.push({ file, reason: `query(${m[3]?.trim()}) is not a literal name` });
          continue;
        }
        const to = `sql/${name}.sql`;
        if (all.has(to)) edges.push({ from: file, to, kind: "REFERENCES", confidence: "high" });
        else unresolved.push({ file, reason: `query("${name}") has no ${to}` });
      }
    }
    return { edges, unresolved };
  },
};

/** @type {import("smarttest/plugin-sdk").SmartTestPlugin} */
export default { apiVersion: 1, name: "sql-edges", edgeProviders: [sqlEdges] };
