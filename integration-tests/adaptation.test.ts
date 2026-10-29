/**
 * 0.7.0 adaptation and end-to-end: sync, migrate, watch, Next.js routes, Playwright/Cypress parsing.
 */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchConfig, SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { cypressSpecPatterns, parseCypressJUnit } from "../packages/adapter-cypress/src/index.js";
import { parsePlaywrightReport } from "../packages/adapter-playwright/src/index.js";
import { nextRoutes, routeMatches } from "../packages/dependency-graph/src/index.js";
import { migrateTestSource } from "../packages/smart-init/src/index.js";
import { FIXTURES, git } from "./helpers.js";

describe("smarttest sync: a project that changes shape", () => {
  it("adopts Git, a new package and a runner switch without re-running init", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-sync-"));
    // A Jest project without Git.
    await cp(join(FIXTURES, "express-cjs-jest"), dir, {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
    await symlink(
      join(FIXTURES, "express-cjs-jest", "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    await writeFile(
      join(dir, "smarttest.config.mjs"),
      'export default {\n  mode: "balanced",\n  adapters: ["jest"],\n  vcs: { provider: "native" },\n};\n',
    );
    let st = await SmartTest.open({ root: dir });
    expect((await st.syncPlan()).drift).toEqual([]);

    // The project moves to Vitest and to Git.
    await rm(join(dir, "node_modules"));
    await mkdir(join(dir, "node_modules"));
    for (const p of ["vitest", ".bin"])
      await symlink(
        join(FIXTURES, "edges-vitest", "node_modules", p),
        join(dir, "node_modules", p),
        "dir",
      );
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    pkg.scripts.test = "vitest run";
    pkg.devDependencies = { vitest: "^5.0.5" };
    delete pkg.jest;
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    await writeFile(
      join(dir, "vitest.config.mjs"),
      "export default { test: { globals: true } };\n",
    );
    // …and gains a package tested with node --test.
    await mkdir(join(dir, "tools/slugger/test"), { recursive: true });
    await writeFile(
      join(dir, "tools/slugger/package.json"),
      '{"name":"slugger","type":"module","scripts":{"test":"node --test test/"}}\n',
    );
    await writeFile(
      join(dir, "tools/slugger/index.js"),
      "export const slug = (s) => s.toLowerCase();\n",
    );
    await writeFile(
      join(dir, "tools/slugger/test/slug.test.js"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { slug } from "../index.js";\ntest("slug", () => assert.equal(slug("A"), "a"));\n',
    );
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "move to vitest");

    st = await SmartTest.open({ root: dir });
    const sync = await st.syncPlan();
    expect(sync.drift.map((d) => d.key).sort()).toEqual(["adapters", "vcs.provider"]);
    expect(sync.after).toContain('adapters: ["vitest", "node"]');
    expect(sync.after).toContain('provider: "auto"');
    const a = await st.analyze();
    expect(a.decision.warnings.join(" ")).toMatch(/out of date/);
    expect(await st.applySync(sync)).toBe(true);
    git(dir, "commit", "-qam", "smarttest sync");

    st = await SmartTest.open({ root: dir });
    expect((await st.syncPlan()).drift).toEqual([]);
    await writeFile(
      join(dir, "src/utils/format.js"),
      (await readFile(join(dir, "src/utils/format.js"), "utf8")).replace(
        "toLowerCase()",
        "toLowerCase().trim()",
      ),
    );
    await writeFile(
      join(dir, "tools/slugger/index.js"),
      "export const slug = (s) => s.toLowerCase().trim();\n",
    );
    const out = await st.run({});
    expect(out.report.decision.selectedTests.map((t) => t.filePath)).toEqual([
      "__tests__/format.test.js",
      "tools/slugger/test/slug.test.js",
    ]);
    expect(out.report.summary.failed).toBe(0);
    expect(out.report.executions.map((e) => e.adapter).sort()).toEqual(["node", "vitest"]);
  }, 120_000);

  it("patches only the keys it changes", () => {
    const text =
      '// mine\nexport default defineConfig({\n  adapters: ["jest"], // keep\n  rules: [],\n});\n';
    const { after } = patchConfig(text, [
      { key: "adapters", current: "", proposed: '["vitest"]', reason: "" },
    ]);
    expect(after).toBe(
      '// mine\nexport default defineConfig({\n  adapters: ["vitest"], // keep\n  rules: [],\n});\n',
    );
  });
});

describe("smarttest migrate --to vitest", () => {
  it("rewrites jest APIs and flags what needs a hand", () => {
    const src =
      'import { jest } from "@jest/globals";\nconst f = jest.fn();\njest.mock("./a", () => ({ ...jest.requireActual("./a") }));\njest.useFakeTimers();\nit("x", (done) => done());\n';
    const { after, notes } = migrateTestSource(src, "a.test.js");
    expect(after).toContain("const f = vi.fn();");
    expect(after).toContain('vi.mock("./a", () => ({ ...await vi.importActual("./a") }));');
    expect(after).toContain("vi.useFakeTimers();");
    expect(after).not.toContain("@jest/globals");
    expect(notes.map((n) => n.message).join(" ")).toMatch(/async/);
    expect(notes.map((n) => n.message).join(" ")).toMatch(/done/);
  });
});

describe("watch", () => {
  it("runs the tests a save affects, comparing with the previous save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-watch-"));
    await cp(join(FIXTURES, "node-test-esm"), dir, {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const st = await SmartTest.open({ root: dir });
    await st.loadIndex();
    const runs: string[][] = [];
    const watcher = await st.watch({
      onRun: (o) => runs.push(o.report.decision.selectedTests.map((t) => t.filePath)),
    });
    await new Promise((r) => setTimeout(r, 300));
    const slug = join(dir, "src/slug.js");
    await writeFile(slug, `${await readFile(slug, "utf8")}\nexport const extra = 1;\n`);
    for (let i = 0; i < 60 && !runs.length; i++) await new Promise((r) => setTimeout(r, 100));
    watcher.close();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toEqual([]); // a new, unused export reaches no test
  }, 60_000);
});

describe("Next.js routes and end-to-end visits", () => {
  it("derives routes from app/ and pages/ conventions", () => {
    const files = [
      "app/page.tsx",
      "app/(shop)/cart/page.tsx",
      "app/users/[id]/page.tsx",
      "app/docs/[...slug]/page.tsx",
      "app/api/health/route.ts",
      "app/layout.tsx",
      "pages/about.tsx",
      "pages/blog/index.tsx",
      "pages/_app.tsx",
      "middleware.ts",
    ];
    const r = nextRoutes(files, [""]);
    expect(r.map((x) => `${x.kind} ${x.route} ${x.file}`).sort()).toEqual(
      [
        "api /api/health app/api/health/route.ts",
        "layout / app/layout.tsx",
        "layout / pages/_app.tsx",
        "middleware / middleware.ts",
        "page / app/page.tsx",
        "page /about pages/about.tsx",
        "page /blog pages/blog/index.tsx",
        "page /cart app/(shop)/cart/page.tsx",
        "page /docs/** app/docs/[...slug]/page.tsx",
        "page /users/* app/users/[id]/page.tsx",
      ].sort(),
    );
  });

  it("matches visited URLs to route patterns", () => {
    expect(routeMatches("/users/42", "/users/*")).toBe(true);
    expect(routeMatches("/users/*", "/users/*")).toBe(true);
    expect(routeMatches("/users/", "/users")).toBe(true);
    expect(routeMatches("/docs/a/b/c", "/docs/**")).toBe(true);
    expect(routeMatches("/users/42/edit", "/users/*")).toBe(false);
    expect(routeMatches("/user*", "/users")).toBe(true);
    expect(routeMatches("/about", "/users/*")).toBe(false);
  });
});

describe("end-to-end adapters", () => {
  it("parses Playwright JSON reports with retries and traces", () => {
    const execs = parsePlaywrightReport(
      {
        config: { rootDir: "/p/e2e" },
        suites: [
          {
            title: "home.spec.ts",
            file: "home.spec.ts",
            specs: [
              {
                title: "loads",
                file: "home.spec.ts",
                tests: [
                  {
                    projectName: "chromium",
                    status: "flaky",
                    results: [
                      {
                        status: "failed",
                        duration: 10,
                        error: { message: "boom" },
                        attachments: [{ name: "trace", path: "/p/test-results/trace.zip" }],
                      },
                      { status: "passed", duration: 5 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      "/p",
      "/p",
    );
    expect(execs).toEqual([
      {
        testId: "e2e/home.spec.ts::loads [chromium]",
        status: "flaky",
        durationMs: 15,
        attempts: 2,
        error: { message: "boom" },
        artifacts: [{ name: "trace", path: "test-results/trace.zip" }],
      },
    ]);
  });

  it("reads Cypress spec patterns and JUnit output", () => {
    expect(
      cypressSpecPatterns(
        'export default defineConfig({ e2e: { specPattern: "cypress/tests/**/*.cy.ts" } })',
      ),
    ).toEqual(["cypress/tests/**/*.cy.ts"]);
    expect(cypressSpecPatterns("export default {}")).toBeUndefined();
    const xml =
      '<testsuites><testsuite name="Root Suite" file="cypress/e2e/a.cy.ts"></testsuite><testsuite name="cart"><testcase name="adds" classname="cart adds" time="0.5"/><testcase name="pays" classname="cart pays" time="1"><failure message="expected 1">AssertionError</failure></testcase></testsuite></testsuites>';
    expect(
      parseCypressJUnit(xml, "cypress/e2e/a.cy.ts").map((e) => [e.testId, e.status, e.durationMs]),
    ).toEqual([
      ["cypress/e2e/a.cy.ts::cart adds", "passed", 500],
      ["cypress/e2e/a.cy.ts::cart pays", "failed", 1000],
    ]);
  });
});
