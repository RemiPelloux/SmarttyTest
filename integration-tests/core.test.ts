import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, git, materialize } from "./helpers.js";

const selectedOf = (st: { decision: { selectedTests: { filePath: string }[] } }) =>
  st.decision.selectedTests.map((t) => t.filePath).sort();

describe("nest-auth-vitest (git)", () => {
  it("selects only the tests that depend on a changed method's class", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/auth/TokenManager.ts", "token.length > 8", "token.length > 7");
    const st = await SmartTest.open({ root: dir });
    const a = await st.analyze();
    expect(selectedOf(a)).toEqual([
      "test/routes/ProtectedRoutes.test.ts",
      "tests/unit/modules/auth/AuthController.test.ts",
      "tests/unit/modules/auth/AuthService.test.ts",
      "tests/unit/modules/auth/TokenManager.test.ts",
    ]);
    expect(a.decision.analysisStatus).toBe("complete");
    const protectedReasons =
      a.decision.selectedTests.find((t) => t.filePath === "test/routes/ProtectedRoutes.test.ts")
        ?.reasons ?? [];
    expect(protectedReasons[0]?.path).toEqual([
      "src/modules/auth/TokenManager.ts#TokenManager",
      "src/modules/auth/AuthService.ts#AuthService",
      "src/modules/auth/AuthenticationMiddleware.ts#auth",
      "src/modules/auth/AuthenticationMiddleware.ts#authenticate",
      "src/routes/protected.ts#protectedRoute",
      "test/routes/ProtectedRoutes.test.ts",
    ]);
    expect(a.decision.skippedTests.map((t) => t.filePath)).toContain(
      "tests/unit/modules/catalog/CatalogService.test.ts",
    );
  }, 60_000);

  it("ignores comment-only changes in FAST mode but not in BALANCED", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(
      dir,
      "src/modules/catalog/CatalogService.ts",
      "list(): Product[] {",
      "// all products\n  list(): Product[] {",
    );
    const st = await SmartTest.open({ root: dir });
    expect(selectedOf(await st.analyze({ mode: "fast" }))).toEqual([]);
    expect(selectedOf(await st.analyze({ mode: "balanced" }))).toEqual([
      "tests/unit/modules/catalog/CatalogService.test.ts",
    ]);
  }, 60_000);

  it("widens to the full suite on mandatory triggers", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "tsconfig.json", '"strict": true', '"strict": false');
    const a = await (await SmartTest.open({ root: dir })).analyze();
    expect(a.decision.fallbackApplied).toBe(true);
    expect(a.decision.selectedTests).toHaveLength(7);
  }, 60_000);

  it("compares against a base branch through the merge-base", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    git(dir, "checkout", "-q", "-b", "feature");
    await edit(
      dir,
      "src/shared/validators/EmailValidator.ts",
      "return /",
      "return value.length < 320 && /",
    );
    git(dir, "commit", "-qam", "tighten email validation");
    const a = await (await SmartTest.open({ root: dir })).analyze({
      source: { kind: "base", ref: "main" },
    });
    // ProtectedRoutes → authenticate → AuthService → isEmail: transitively affected.
    expect(selectedOf(a)).toEqual([
      "test/routes/ProtectedRoutes.test.ts",
      "tests/unit/modules/auth/AuthController.test.ts",
      "tests/unit/modules/auth/AuthService.test.ts",
      "tests/unit/modules/users/UserService.test.ts",
      "tests/unit/shared/validators/EmailValidator.test.ts",
    ]);
  }, 60_000);

  it("selects the dependents of a deleted file (warm index)", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    const st = await SmartTest.open({ root: dir });
    await st.analyze(); // warm the index while the file exists
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, "src/modules/users/UserRepository.ts"));
    const a = await (await SmartTest.open({ root: dir })).analyze();
    expect(selectedOf(a)).toEqual(["tests/unit/modules/users/UserService.test.ts"]);
  }, 60_000);

  it("runs the selection through Vitest and reports skipped tests as not run", async () => {
    const dir = await materialize("nest-auth-vitest", { git: true });
    await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "sum - p.price");
    const st = await SmartTest.open({ root: dir });
    const out = await st.run({ formats: ["json", "html", "junit", "markdown"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "tests/unit/modules/catalog/CatalogService.test.ts",
    ]);
    expect(out.report.executions[0]?.status).toBe("failed");
    expect(out.exitCode).toBe(1);
    expect(out.report.summary.skippedBySelection).toBe(6);
    expect(out.integrityIssues).toEqual([]);
    const html = await readFile(out.written.html as string, "utf8");
    expect(html).toContain("not run");
  }, 120_000);
});

describe("express-cjs-jest (git)", () => {
  it("handles CommonJS at file level and runs Jest", async () => {
    const dir = await materialize("express-cjs-jest", { git: true });
    await edit(dir, "src/utils/format.js", "toLowerCase()", "toLowerCase().trim()");
    const st = await SmartTest.open({ root: dir });
    const out = await st.run({ formats: ["json"] });
    expect(out.report.decision.selectedTests.map((t) => t.filePath).sort()).toEqual([
      "__tests__/app.test.js",
      "__tests__/format.test.js",
      "__tests__/userService.test.js",
    ]);
    expect(out.report.executions.every((e) => e.status === "passed")).toBe(true);
    expect(out.exitCode).toBe(0);
  }, 120_000);
});

describe("no-vcs-vitest (native snapshots)", () => {
  it("runs everything without a baseline, then only affected tests", async () => {
    const dir = await materialize("no-vcs-vitest");
    const st = await SmartTest.open({ root: dir });
    const first = await st.run({ formats: ["json"] });
    expect(first.report.decision.fallbackApplied).toBe(true);
    expect(first.report.summary.selected).toBe(2);
    expect(first.exitCode).toBe(0);
    await writeFile(
      join(dir, "src/strings.ts"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is TypeScript source written to a fixture
      "export function shout(text: string): string {\n  return `${text.toUpperCase()}!`;\n}\nexport const whisper = (t: string) => t.toLowerCase();\n",
    );
    const second = await (await SmartTest.open({ root: dir })).run({ formats: ["json"] });
    expect(second.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "tests/strings.test.ts",
    ]);
    expect(second.report.change.changeSet.provider).toBe("native");
  }, 120_000);
});
