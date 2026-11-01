import { describe, expect, it } from "vitest";
import { escapeRe, parsePlaywrightReport, playwrightRunErrors, specFileFilter } from "./index.js";

describe("Playwright results that are not a pass", () => {
  // Recorded from Playwright 1.56: project `main` depends on `setup`, and setup throws.
  const p1 = {
    config: { rootDir: "/p/e2e" },
    suites: [
      {
        title: "auth.setup.js",
        file: "auth.setup.js",
        specs: [
          {
            title: "authenticate",
            file: "auth.setup.js",
            tests: [
              {
                projectName: "setup",
                status: "unexpected",
                results: [{ status: "failed", error: { message: "Error: setup failed" } }],
              },
            ],
          },
        ],
      },
      {
        title: "home.spec.js",
        file: "home.spec.js",
        specs: [
          {
            title: "home",
            file: "home.spec.js",
            tests: [{ projectName: "main", status: "skipped", results: [] }],
          },
          {
            title: "skips itself",
            file: "home.spec.js",
            tests: [{ projectName: "main", status: "skipped", results: [{ status: "skipped" }] }],
          },
        ],
      },
    ],
    errors: [],
  };

  it("reports a test skipped because a dependency project failed as not run, not skipped", () => {
    const r = parsePlaywrightReport(p1, "/p", "/p");
    expect(r.map((e) => [e.testId, e.status])).toEqual([
      ["e2e/auth.setup.js::authenticate [setup]", "failed"],
      ["e2e/home.spec.js::home [main]", "cancelled"],
      ["e2e/home.spec.js::skips itself [main]", "skipped"],
    ]);
    expect(r[1]?.error?.message).toContain("Not run");
  });

  it("reads the errors Playwright records outside any test (a failing globalTeardown)", () => {
    expect(
      playwrightRunErrors({ errors: [{ message: "Error: teardown boom: leaked state" }, {}] }),
    ).toEqual(["Error: teardown boom: leaked state"]);
    expect(playwrightRunErrors(undefined)).toEqual([]);
  });
});

describe("spec filters (SR-05)", () => {
  it("never passes a spec file named like an option as an option", () => {
    const filter = escapeRe("--config=evil.spec.ts");
    expect(filter.startsWith("-")).toBe(false);
    expect(new RegExp(filter).test("/repo/--config=evil.spec.ts")).toBe(true);
    expect(new RegExp(filter).test("/repo/--configXevil.spec.ts")).toBe(false);
    expect(escapeRe("e2e/a.spec.ts")).toBe("e2e/a\\.spec\\.ts");
  });

  it("a selected spec's filter matches that file only (Playwright: `gi` regex on the absolute path)", () => {
    // How Playwright 1.56 builds a CLI file filter (util.js forceRegExp / createFileMatcher).
    const matches = (filter: string, abs: string) => {
      expect(/^\/(.*)\/([gi]*)$/.test(filter)).toBe(false); // never read as /re/flags
      expect(/^(.*?):(\d+):?(\d+)?$/.test(filter)).toBe(false); // never read as file:line
      return new RegExp(filter, "gi").test(abs);
    };
    const f = specFileFilter(["/repo/home.spec.ts", "/private/repo/home.spec.ts"]);
    expect(f.startsWith("-")).toBe(false);
    expect(matches(f, "/repo/home.spec.ts")).toBe(true);
    expect(matches(f, "/private/repo/home.spec.ts")).toBe(true);
    expect(matches(f, "/repo/myhome.spec.ts")).toBe(false);
    expect(matches(f, "/repo/e2e/home.spec.ts")).toBe(false);
    expect(matches(f, "/repo/home.spec.tsx")).toBe(false);
    expect(matches(f, "/other/repo/home.spec.ts")).toBe(false);
    expect(matches(f, "/repo/homeXspec.ts")).toBe(false);
    const w = specFileFilter(["C:\\repo\\e2e\\home.spec.ts"]);
    expect(matches(w, "C:\\repo\\e2e\\home.spec.ts")).toBe(true);
    expect(matches(w, "C:\\repo\\e2e\\myhome.spec.ts")).toBe(false);
    const g = specFileFilter(["/repo/e2e/[id]/--config=(a)+.spec.ts"]);
    expect(matches(g, "/repo/e2e/[id]/--config=(a)+.spec.ts")).toBe(true);
    expect(matches(g, "/repo/e2e/i/--config=aa.spec.ts")).toBe(false);
    expect(matches(specFileFilter(["/repo/home.spec.ts:12"]), "/repo/home.spec.ts:12")).toBe(true);
  });
});
