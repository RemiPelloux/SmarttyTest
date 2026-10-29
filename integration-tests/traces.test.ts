/**
 * 0.5.0 runtime evidence: traces rule out statically reachable tests that never ran the changed
 * code, only while the trace is fresh, and never in SAFE mode.
 */
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const selected = (a: Awaited<ReturnType<SmartTest["analyze"]>>) =>
  a.decision.selectedTests.map((t) => t.filePath).sort();

describe("traces (edges-vitest)", () => {
  it("records per-test execution and narrows class-level selections", async () => {
    const dir = await materialize("edges-vitest", { git: true });
    const st = await SmartTest.open({ root: dir });
    const r = await st.collectTraces({ files: ["tests/price.test.ts", "tests/discount.test.ts"] });
    expect(r.traced).toBe(2);
    expect(r.store.tests["tests/price.test.ts"]?.executed["src/shop.ts"]).toContain("price");
    expect(r.store.tests["tests/price.test.ts"]?.executed["src/shop.ts"]).not.toContain("discount");

    await edit(dir, "src/shop.ts", "n > 2 ? 5 : 0", "n > 3 ? 5 : 0");
    // Static: makeShop() returns an untyped value, so both tests reach every Shop method.
    const staticOnly = await (await SmartTest.open({ root: dir })).analyze({ mode: "safe" });
    expect(selected(staticOnly)).toEqual(
      expect.arrayContaining(["tests/discount.test.ts", "tests/price.test.ts"]),
    );
    const hybrid = await (await SmartTest.open({ root: dir })).analyze();
    expect(selected(hybrid)).toEqual(["tests/discount.test.ts"]);
    expect(hybrid.decision.details.observedSkips?.map((s) => s.test)).toEqual([
      "tests/price.test.ts",
    ]);
    const skip = hybrid.decision.skippedTests.find((t) => t.filePath === "tests/price.test.ts");
    expect(skip?.reasons[0]).toContain("never ran the changed code");
  }, 120_000);

  it("drops traces whose loaded files changed since tracing", async () => {
    const dir = await materialize("edges-vitest", { git: true });
    const st = await SmartTest.open({ root: dir });
    await st.collectTraces({ files: ["tests/price.test.ts", "tests/discount.test.ts"] });
    // A commit after tracing changes a file the traces loaded: they are stale for later changes.
    await edit(dir, "src/shop.ts", "return n * 10;", "return n * 10 + 0;");
    git(dir, "commit", "-qam", "touch shop");
    await edit(dir, "src/shop.ts", "n > 2 ? 5 : 0", "n > 3 ? 5 : 0");
    const a = await (await SmartTest.open({ root: dir })).analyze();
    expect(selected(a)).toEqual(
      expect.arrayContaining(["tests/discount.test.ts", "tests/price.test.ts"]),
    );
    expect(a.decision.details.observedSkips).toBeUndefined();
  }, 120_000);
});
