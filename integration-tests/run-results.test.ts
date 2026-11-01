/**
 * A run is never reported as passed when the real runner failed it: hook failures, unhandled
 * errors and other failures outside any test (§32.2). Real Vitest, through the adapter and the
 * executor.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import { describe, expect, it } from "vitest";
import { executeGroups } from "../packages/test-executor/src/index.js";
import { materialize } from "./helpers.js";

describe("failures outside any test fail the run (Vitest)", () => {
  it("a failing beforeAll or afterAll fails its file; its skipped tests are not run, not skipped", async () => {
    const root = await materialize("nest-auth-vitest");
    await writeFile(
      join(root, "tests/before-all.test.ts"),
      'import { beforeAll, describe, expect, it } from "vitest";\ndescribe("d", () => {\n  beforeAll(() => { throw new Error("beforeAll boom"); });\n  it("works", () => expect(1).toBe(1));\n});\n',
    );
    await writeFile(
      join(root, "tests/after-all.test.ts"),
      'import { afterAll, describe, expect, it } from "vitest";\ndescribe("d", () => {\n  afterAll(() => { throw new Error("afterAll boom"); });\n  it("works", () => expect(1).toBe(1));\n});\n',
    );
    const files = ["tests/after-all.test.ts", "tests/before-all.test.ts"];
    const res = await executeGroups([{ adapter: "vitest", dir: "", files }], {
      createAdapter: () => new VitestAdapter({ projectRoot: root, cwd: root }),
    });
    expect(res.files.map((f) => [f.file, f.status])).toEqual([
      ["tests/after-all.test.ts", "failed"],
      ["tests/before-all.test.ts", "failed"],
    ]);
    const before = res.files[1]?.tests ?? [];
    expect(before.find((t) => t.testId.endsWith("::d works"))?.status).toBe("cancelled");
    expect(before.some((t) => t.status === "skipped")).toBe(false);
    // Vitest's JSON has no message for it; the error comes from its console output.
    expect(before.find((t) => t.testId.endsWith("::(suite)"))?.error?.message).toContain(
      "beforeAll boom",
    );
  }, 120_000);

  it("an unhandled error fails every file of the run, with Vitest's own error text", async () => {
    const root = await materialize("nest-auth-vitest");
    await writeFile(
      join(root, "tests/unhandled.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", async () => {\n  setTimeout(() => { throw new Error("unhandled boom"); }, 1);\n  await new Promise((r) => setTimeout(r, 30));\n  expect(1).toBe(1);\n});\n',
    );
    const files = ["tests/unhandled.test.ts", "tests/unit/modules/catalog/CatalogService.test.ts"];
    const res = await executeGroups([{ adapter: "vitest", dir: "", files }], {
      createAdapter: () => new VitestAdapter({ projectRoot: root, cwd: root }),
    });
    expect(res.files.map((f) => f.status)).toEqual(["failed", "failed"]);
    const run = res.files[0]?.tests.find((t) => t.testId === "tests/unhandled.test.ts::(run)");
    expect(run?.status).toBe("failed");
    expect(run?.error?.message).toContain("exited with code 1 although no test failed");
    expect(run?.error?.message).toContain("unhandled boom");
  }, 120_000);
});
