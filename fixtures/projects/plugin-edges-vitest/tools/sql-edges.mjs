/**
 * A SmartTest plugin (Plugin SDK v1): `query("name")` reads sql/<name>.sql at run time, which
 * static analysis cannot see. This edge provider links each caller to the SQL file it reads.
 * A query name that is not a string literal, or that has no file, is reported as unresolved.
 * Only the first argument names the file; the helper's own definition (`function query(`) and
 * other objects' methods (`pool.query(`) are not calls to it.
 */
const CALL = /(?<![\w.$]|function\s*)query\(\s*(?:(["'`])([\w-]+)\1|([^,)]*))/g;

/** @type {import("@tkmremi/smarttest/plugin-sdk").EdgeProvider} */
const sqlEdges = {
  apiVersion: 1,
  id: "sql-queries",
  getCapabilities: () => ({ fileEdges: true, unresolved: true, nonSourceFiles: true }),
  async provideEdges(ctx) {
    const all = new Set(await ctx.listFiles());
    const edges = [];
    const unresolved = [];
    for (const file of [...ctx.files].sort()) {
      if (ctx.isTest(file) || !file.startsWith("src/")) continue;
      const text = (await ctx.readFile(file)) ?? "";
      for (const m of text.matchAll(CALL)) {
        const name = m[2];
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

/** @type {import("@tkmremi/smarttest/plugin-sdk").SmartTestPlugin} */
export default { apiVersion: 1, name: "sql-edges", edgeProviders: [sqlEdges] };
