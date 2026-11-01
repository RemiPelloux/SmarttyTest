/**
 * 1.0.0 performance: the dependency graph persisted between runs (`.smarttest/state/graph.json`).
 * A stored graph is used only when it provably describes the current analyses; every other case
 * rebuilds, and the selection always equals the one a rebuild makes.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Analysis, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

const selection = (a: Analysis) => a.decision.selectedTests.map((t) => t.filePath).sort();
const graphFile = (dir: string) => join(dir, ".smarttest", "state", "graph.json");

/** An analysis through the store, then the reference: the same analysis with no stored graph. */
async function analyzeBoth(dir: string) {
  const st = await SmartTest.open({ root: dir });
  const stored = await st.analyze();
  const how = { build: st.lastGraphBuild, miss: st.lastGraphStoreMiss };
  const saved = await readFile(graphFile(dir), "utf8");
  await rm(graphFile(dir));
  const ref = await SmartTest.open({ root: dir });
  const reference = await ref.analyze();
  expect(ref.lastGraphBuild).toBe("built");
  expect(selection(stored)).toEqual(selection(reference));
  expect(stored.graph.stats).toEqual(reference.graph.stats);
  // Put back what the stored run left, so the next step starts from it.
  await writeFile(graphFile(dir), saved);
  return { ...how, analysis: stored };
}

describe("persisted dependency graph", () => {
  it("loads, patches and rebuilds as the analyses require, selecting what a rebuild selects", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const first = await SmartTest.open({ root: dir });
    await first.analyze();
    expect(first.lastGraphBuild).toBe("built");
    expect(first.lastGraphStoreMiss).toMatch(/^missing/);

    // Nothing changed: restored as is.
    expect((await analyzeBoth(dir)).build).toBe("loaded");

    // A body change: the stored graph is patched for that file.
    await edit(
      dir,
      "src/modules/auth/AuthService.ts",
      "return this.tokens.verify(token);",
      "return token.length > 0;",
    );
    const patched = await analyzeBoth(dir);
    expect(patched.build).toBe("patched");
    expect(
      patched.analysis.graph.why(
        "src/modules/auth/TokenManager.ts#TokenManager.verify",
        "test/routes/ProtectedRoutes.test.ts",
      ),
    ).toBeUndefined();
    // A few patched files are patched again from the stored graph next time (not rewritten).
    expect((await analyzeBoth(dir)).build).toBe("patched");

    // An export change is structural: rebuilt.
    await edit(
      dir,
      "src/modules/auth/AuthService.ts",
      "export class AuthService",
      "export class AuthService2 {}\nexport class AuthService",
    );
    const exported = await analyzeBoth(dir);
    expect(exported.build).toBe("built");
    expect(exported.miss).toMatch(/^structural: .*AuthService\.ts/);

    // A file added, then deleted.
    await writeFile(
      join(dir, "tests/unit/modules/auth/Extra.test.ts"),
      'import { it } from "vitest";\nimport { TokenManager } from "../../../../src/modules/auth/TokenManager";\nit("x", () => { new TokenManager(); });\n',
    );
    const added = await analyzeBoth(dir);
    expect(added.build).toBe("built");
    expect(added.miss).toMatch(/files added or removed/);
    expect((await analyzeBoth(dir)).build).toBe("loaded");
    await rm(join(dir, "tests/unit/modules/auth/Extra.test.ts"));
    const removed = await analyzeBoth(dir);
    expect(removed.build).toBe("built");
    expect(removed.miss).toMatch(/files added or removed/);

    // A configuration change.
    await writeFile(join(dir, "smarttest.config.json"), JSON.stringify({ mode: "safe" }));
    const configured = await analyzeBoth(dir);
    expect(configured.build).toBe("built");
    expect(configured.miss).toMatch(/configuration changed/);
  }, 180_000);

  it("rebuilds after a SmartTest version change or a damaged store", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(
      dir,
      "src/modules/auth/TokenManager.ts",
      "verify(token: string)",
      "verify(token: string /* edited */)",
    );
    await (await SmartTest.open({ root: dir })).analyze();
    const good = await readFile(graphFile(dir), "utf8");
    const nl = good.indexOf("\n");
    const header = JSON.parse(good.slice(0, nl)) as Record<string, unknown>;
    const body = good.slice(nl + 1);

    const cases: [string, string, RegExp][] = [
      [
        "another version",
        `${JSON.stringify({ ...header, version: "0.0.1" })}\n${body}`,
        /^stale: SmartTest version changed/,
      ],
      [
        "another format",
        `${JSON.stringify({ ...header, format: -1 })}\n${body}`,
        /^stale: graph format changed/,
      ],
      ["garbage", "not json at all", /^corrupt/],
      ["empty", "", /^corrupt/],
      ["truncated", good.slice(0, Math.floor(good.length * 0.7)), /^corrupt/],
      [
        "a flipped edge",
        `${good.slice(0, nl + 1)}${body.replace(/"deps":\[(\d)/, (_m, d) => `"deps":[${(Number(d) + 1) % 10}`)}`,
        /^corrupt: checksum/,
      ],
      [
        "a stale file entry",
        `${JSON.stringify({ ...header, files: { ...(header.files as object), "src/ghost.ts": ["x", "y"] } })}\n${body}`,
        /^structural: files added or removed/,
      ],
    ];
    for (const [name, text, reason] of cases) {
      await writeFile(graphFile(dir), text);
      const st = await SmartTest.open({ root: dir });
      const a = await st.analyze();
      expect(st.lastGraphBuild, name).toBe("built");
      expect(st.lastGraphStoreMiss, name).toMatch(reason);
      // The rebuilt graph replaced the damaged store.
      const after = await SmartTest.open({ root: dir });
      const b = await after.analyze();
      expect(after.lastGraphBuild, name).toBe("loaded");
      expect(selection(b), name).toEqual(selection(a));
      expect(selection(a).length, name).toBeGreaterThan(0);
    }
  }, 180_000);
});
