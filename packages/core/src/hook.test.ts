import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookRecord, HookRecords } from "./hook.js";
import {
  cleanGitEnv,
  describeScope,
  escapesCheckout,
  estimateRunMs,
  normalizeProject,
  onlyDeletions,
  outsideHookScope,
  planChecks,
  recordForTree,
  savedText,
  scopeIsEmpty,
  trailerValue,
  unknownCheckProjects,
} from "./hook.js";

describe("hook scope", () => {
  const selected = [
    { file: "src/a.test.ts", adapter: "vitest" },
    { file: "e2e/login.spec.ts", adapter: "playwright" },
    { file: "e2e/helpers.test.ts", adapter: "vitest" },
    { file: "orphan.test.ts", adapter: undefined },
  ];

  it("removes nothing without a scope", () => {
    expect(scopeIsEmpty(undefined)).toBe(true);
    expect(scopeIsEmpty({ exclude: [] })).toBe(true);
    expect(outsideHookScope(selected, { exclude: [] })).toEqual([]);
    expect(describeScope({ exclude: [] })).toEqual([]);
  });

  it("leaves other runners' tests to CI with the rule that removed them", () => {
    expect(outsideHookScope(selected, { runners: ["vitest"] })).toEqual([
      { file: "e2e/login.spec.ts", adapter: "playwright", rule: "hook.runners [vitest]" },
    ]);
  });

  it("never leaves a test without a runner out of the hook through `runners`", () => {
    // The normal path reports it (no runner collects it); a scope must not hide it.
    expect(
      outsideHookScope(selected, { runners: ["vitest"] }).some((l) => l.file === "orphan.test.ts"),
    ).toBe(false);
  });

  it("leaves excluded files to CI whatever their runner", () => {
    expect(outsideHookScope(selected, { exclude: ["e2e/**"] })).toEqual([
      { file: "e2e/login.spec.ts", adapter: "playwright", rule: 'hook.exclude "e2e/**"' },
      { file: "e2e/helpers.test.ts", adapter: "vitest", rule: 'hook.exclude "e2e/**"' },
    ]);
    expect(describeScope({ runners: ["vitest", "jest"], exclude: ["e2e/**"] })).toEqual([
      "hook.runners [vitest, jest]",
      'hook.exclude ["e2e/**"]',
    ]);
  });
});

describe("temporary checkout isolation (SR-08)", () => {
  it("does not mirror node_modules into a project directory that links out of the checkout", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-wt-"));
    try {
      const wt = join(base, "repo");
      await mkdir(join(wt, "packages", "app"), { recursive: true });
      await mkdir(join(base, "home"));
      await symlink(join(base, "home"), join(wt, "packages", "evil"), "junction");
      expect(await escapesCheckout(wt, join(wt, "packages", "evil"))).toBe(true);
      expect(await escapesCheckout(wt, join(wt, "packages", "app"))).toBe(false);
      expect(await escapesCheckout(wt, wt)).toBe(false);
      expect(await escapesCheckout(wt, join(wt, "missing"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("removes every repository-locating Git variable from the checkout's environment", () => {
    const env = cleanGitEnv({
      PATH: "/bin",
      GIT_DIR: "/r/.git",
      GIT_COMMON_DIR: "/r/.git",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/r/.git/objects",
      GIT_NAMESPACE: "ns",
      GIT_INDEX_FILE: "/r/.git/index",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("project checks", () => {
  it("matches a check scoped to a project however its directory is written", () => {
    for (const dir of ["packages/app", "packages/app/", "./packages/app", ".\\packages\\app"]) {
      const planned = planChecks(
        [{ name: "types", run: "tsc", projects: [dir] }],
        "pre-commit",
        [{ path: "packages/app/src/a.ts" }],
        ["", "packages/app/"],
      );
      expect(planned, dir).toEqual([{ name: "types", project: "packages/app", command: "tsc" }]);
    }
    expect(normalizeProject("./")).toBe("");
    expect(normalizeProject(".")).toBe("");
  });

  it("reports a check whose project is unknown instead of dropping it silently", () => {
    const checks = [
      { name: "types", run: "tsc", projects: ["./packages/app/", "packages/nope"] },
      { name: "build", run: "make", projects: ["packages/gone"], stage: "pre-push" as const },
    ];
    const warnings = unknownCheckProjects(checks, "pre-commit", ["", "packages/app"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"packages/nope"');
  });

  it("never lets a changed file be read as an option", () => {
    const [planned] = planChecks(
      [{ name: "lint", run: "eslint {files}" }],
      "pre-commit",
      [{ path: "--rulesdir=x.js" }, { path: "src/it's.ts" }],
      [""],
    );
    expect(planned?.command).toBe("eslint './--rulesdir=x.js' './src/it'\\''s.ts'");
  });
});

describe("pre-push refs", () => {
  const ref = (localSha: string) => ({
    localRef: "(delete)",
    localSha,
    remoteRef: "refs/heads/x",
    remoteSha: "1".repeat(40),
  });

  it("recognises a push that only deletes remote refs", () => {
    expect(onlyDeletions([ref("0".repeat(40))])).toBe(true);
    expect(onlyDeletions([ref("0".repeat(40)), ref("2".repeat(40))])).toBe(false);
    expect(onlyDeletions([])).toBe(false);
  });
});

describe("estimateRunMs", () => {
  it("divides a group's files over its workers, never below its slowest file", () => {
    // 30 files of 5 s in Vitest on 16 cores: about 10 s, not 150 s.
    const vitest = Array.from({ length: 30 }, () => ({ ms: 5000, group: "v", adapter: "vitest" }));
    expect(estimateRunMs(vitest, 16)).toBe(10_000);
    expect(estimateRunMs([...vitest, { ms: 40_000, group: "v", adapter: "vitest" }], 16)).toBe(
      40_000,
    );
    // Cypress runs one spec at a time; --workers overrides the default.
    const cy = [1, 2, 3].map(() => ({ ms: 10_000, group: "c", adapter: "cypress" }));
    expect(estimateRunMs(cy, 16)).toBe(30_000);
    expect(estimateRunMs(vitest, 16, 2)).toBe(75_000);
    expect(estimateRunMs([], 16)).toBe(0);
  });
});

describe("commit trailer", () => {
  const run = (over: Partial<HookRecord> = {}): HookRecord => ({
    at: "2026-11-06T10:00:00.000Z",
    stage: "pre-commit",
    durationMs: 1000,
    selected: 12,
    passed: true,
    tree: "t1",
    executed: 12,
    notRun: 2340,
    savedMs: 4 * 60_000,
    ...over,
  });
  const records = (runs: HookRecord[], bypasses: HookRecords["bypasses"] = []): HookRecords => ({
    version: 1,
    runs,
    bypasses,
  });

  it("formats what the pre-commit run did", () => {
    expect(trailerValue(run())).toBe("12 run, 2,340 not run · ~4 min saved");
    expect(trailerValue(run({ leftToCi: 3, live: 2, savedMs: 400 }))).toBe(
      "12 run, 2,340 not run, 3 left to CI, 2 live, not run",
    );
    expect(savedText(999)).toBeUndefined();
    expect(savedText(12_400)).toBe("~12 s saved");
    expect(savedText(59_600)).toBe("~1 min saved");
    expect(savedText(125 * 60_000)).toBe("~2 h 5 min saved");
  });

  it("never backs a trailer with a failed, pre-push or older record", () => {
    expect(trailerValue(run({ passed: false }))).toBeUndefined();
    expect(trailerValue(run({ stage: "pre-push" }))).toBeUndefined();
    // A record written before the trailer existed has no counts: no trailer rather than a guess.
    const { executed: _executed, ...old } = run();
    expect(trailerValue(old)).toBeUndefined();
  });

  it("uses the latest pre-commit run on exactly the committed tree", () => {
    const ok = run();
    expect(recordForTree(records([ok]), "t1")).toBe(ok);
    expect(recordForTree(records([ok]), "t2")).toBeUndefined();
    // The latest run on that tree failed: no trailer, even though an earlier one passed.
    expect(
      recordForTree(records([ok, run({ passed: false, at: "2026-11-06T10:05:00.000Z" })]), "t1"),
    ).toBeUndefined();
    // A pre-push record on the same tree does not describe a commit.
    expect(recordForTree(records([run({ stage: "pre-push" })]), "t1")).toBeUndefined();
  });

  it("gives no trailer when the hook was bypassed after the matching run", () => {
    const bypass = {
      at: "2026-11-06T10:01:00.000Z",
      stage: "pre-commit",
      reason: "SMARTTEST_SKIP=1",
    };
    expect(recordForTree(records([run()], [bypass]), "t1")).toBeUndefined();
    const older = { ...bypass, at: "2026-11-06T09:00:00.000Z" };
    expect(recordForTree(records([run()], [older]), "t1")).toBeDefined();
  });
});
