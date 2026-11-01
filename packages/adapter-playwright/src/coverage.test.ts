import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coveragePageFixture, withBrowserCoverage } from "./coverage.js";
import { BROWSER_COVERAGE_ENV, PlaywrightAdapter } from "./index.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "st-pw-cov-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakePage() {
  const calls: string[] = [];
  return {
    calls,
    coverage: {
      async startJSCoverage() {
        calls.push("start");
      },
      async stopJSCoverage() {
        calls.push("stop");
        return [{ url: "http://127.0.0.1/app.js", source: "x", functions: [] }];
      },
    },
  };
}

describe("browser coverage page fixture", () => {
  it("records Chromium V8 coverage per test when SmartTest sets a directory", async () => {
    const out = join(dir, "v8");
    const fixture = coveragePageFixture(() => out);
    const page = fakePage();
    let used = false;
    await fixture(
      { page, browserName: "chromium" },
      async () => {
        used = true;
      },
      { file: "/p/e2e/a.spec.ts", testId: "abc", retry: 1, project: { name: "chromium" } },
    );
    expect(used).toBe(true);
    expect(page.calls).toEqual(["start", "stop"]);
    const files = await readdir(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-1\.json$/);
    const dump = JSON.parse(await readFile(join(out, files[0] as string), "utf8"));
    expect(dump).toMatchObject({ testFile: "/p/e2e/a.spec.ts", testId: "abc" });
    expect(dump.entries[0].url).toBe("http://127.0.0.1/app.js");
  });

  it("does nothing outside a coverage run or outside Chromium", async () => {
    for (const [out, browserName] of [
      [undefined, "chromium"],
      [join(dir, "v8"), "firefox"],
    ] as const) {
      const page = fakePage();
      await coveragePageFixture(() => out)({ page, browserName }, async () => {}, {});
      expect(page.calls).toEqual([]);
    }
    await expect(readdir(join(dir, "v8"))).rejects.toThrow();
  });

  it("wraps a Playwright test through extend with a page fixture", () => {
    let fixtures: Record<string, unknown> = {};
    const base = {
      extend(f: Record<string, unknown>) {
        fixtures = f;
        return "extended";
      },
    };
    expect(withBrowserCoverage(base)).toBe("extended");
    expect(typeof fixtures.page).toBe("function");
    // Playwright reads a fixture's dependencies from its first parameter's destructuring.
    expect(String(fixtures.page)).toMatch(/^async \(\{\s*page,\s*browserName\s*\}/);
  });
});

describe("adapter coverage plumbing", () => {
  it("declares coverage as partial and empties the dump directory before a coverage run", async () => {
    const adapter = new PlaywrightAdapter({ projectRoot: dir, cwd: dir, coverageDir: dir });
    expect(adapter.getCapabilities().coverage).toBe("partial");
    await mkdir(join(dir, "v8"), { recursive: true });
    await writeFile(join(dir, "v8", "old.json"), "{}");
    const env = await adapter.coverageEnv({ coverage: true });
    expect(env[BROWSER_COVERAGE_ENV]).toBe(join(dir, "v8"));
    expect(await readdir(join(dir, "v8"))).toEqual([]);
    expect(await adapter.coverageEnv({ coverage: false })).toEqual({});
    const without = new PlaywrightAdapter({ projectRoot: dir, cwd: dir });
    expect(await without.coverageEnv({ coverage: true })).toEqual({});
  });
});
