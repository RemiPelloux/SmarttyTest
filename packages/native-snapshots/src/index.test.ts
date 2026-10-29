import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "@smarttest/shared";
import { describe, expect, it } from "vitest";
import { SnapshotStore } from "./index.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "st-snap-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  const store = new SnapshotStore(root, join(root, ".smarttest"), () => walkFiles(root));
  return { root, store };
}

describe("SnapshotStore", () => {
  it("reports no baseline before the first snapshot", async () => {
    const { store } = await project();
    const input = await store.getChangeInput({ kind: "snapshot" });
    expect(input.changeSet.completeness).toBe("unknown");
  });

  it("detects modifications, additions, renames and deletions", async () => {
    const { root, store } = await project();
    await store.create({ storeContent: true });
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\nexport const a2 = 3;\n");
    await writeFile(join(root, "src/c.ts"), "export const c = 4;\n");
    await writeFile(join(root, "src/b2.ts"), "export const b = 2;\n");
    await rm(join(root, "src/b.ts"));
    const { changeSet } = await store.diff();
    expect(changeSet.completeness).toBe("complete");
    expect(changeSet.changes.map((c) => [c.type, c.path, c.previousPath ?? null])).toEqual([
      ["modified", "src/a.ts", null],
      ["renamed", "src/b2.ts", "src/b.ts"],
      ["added", "src/c.ts", null],
    ]);
    const a = changeSet.changes.find((c) => c.path === "src/a.ts");
    expect(a?.changedRanges?.[0]?.start.line).toBe(1);
  });

  it("marks hash-only comparisons as partial", async () => {
    const { root, store } = await project();
    await store.create();
    await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
    const { changeSet } = await store.diff();
    expect(changeSet.completeness).toBe("partial");
  });

  it("prunes but keeps verified baselines", async () => {
    const { store } = await project();
    const first = await store.create();
    await store.markVerified(first.id, "run_1", "passed");
    await store.create();
    await store.create();
    const removed = await store.prune({ keep: 1 });
    expect(removed).not.toContain(first.id);
    expect(removed).toHaveLength(1);
  });
});
