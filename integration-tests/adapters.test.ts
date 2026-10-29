import { join } from "node:path";
import { JestAdapter } from "@smarttest/adapter-jest";
import { VitestAdapter } from "@smarttest/adapter-vitest";
import { checkTestAdapterConformance } from "@smarttest/plugin-sdk";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./helpers.js";

describe("adapter conformance (plugin SDK kit)", () => {
  it("Vitest adapter declares every capability and discovers real tests", async () => {
    const root = join(FIXTURES, "nest-auth-vitest");
    const adapter = new VitestAdapter({ projectRoot: root, cwd: root });
    expect(await checkTestAdapterConformance(adapter)).toEqual([]);
    expect((await adapter.discover()).map((t) => t.filePath)).toContain(
      "test/routes/ProtectedRoutes.test.ts",
    );
  }, 60_000);

  it("Jest adapter declares every capability and discovers real tests", async () => {
    const root = join(FIXTURES, "express-cjs-jest");
    const adapter = new JestAdapter({ projectRoot: root, cwd: root });
    expect(await checkTestAdapterConformance(adapter)).toEqual([]);
    expect((await adapter.discover()).map((t) => t.filePath).sort()).toEqual([
      "__tests__/app.test.js",
      "__tests__/format.test.js",
      "__tests__/invoice.test.js",
      "__tests__/userService.test.js",
    ]);
  }, 60_000);
});
