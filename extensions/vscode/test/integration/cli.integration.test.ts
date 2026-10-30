/**
 * Integration tests against the real smarttest CLI and a real fixture project.
 *
 * By default the test uses `packages/cli/dist/bin.js` when it exists (run
 * `pnpm build` first). Set `SMARTTEST_CLI` to a different executable, or the
 * tests are reported as skipped with the reason visible in the test output.
 *
 *   SMARTTEST_CLI=/abs/path/packages/cli/dist/bin.js \
 *     node scripts/tool.mjs vitest run --config vitest.config.ts test/integration
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  explainArgs,
  explainTarget,
  graphArgs,
  impactArgs,
  runAffectedArgs,
  scanArgs,
} from "../../src/cli/commands.js";
import { runCli } from "../../src/cli/runner.js";
import { analyzeFile } from "../../src/core/analysis.js";
import {
  parseExplainJson,
  parseGraphDump,
  parseImpactJson,
  parseRunJson,
  parseScanJson,
} from "../../src/core/contracts.js";

const cli =
  process.env.SMARTTEST_CLI ??
  fileURLToPath(new URL("../../../../packages/cli/dist/bin.js", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../../../../fixtures/projects/ts-lib-vitest", import.meta.url),
);
const available = existsSync(cli) && existsSync(fixturePath);

async function call(args: string[], cwd = fixturePath, timeoutMs = 60_000) {
  const result = await runCli({
    executable: process.execPath,
    args: [cli, ...args],
    cwd,
    signal: new AbortController().signal,
    timeoutMs,
  });
  return result;
}

function copyFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "smarttest-vscode-"));
  cpSync(fixturePath, directory, {
    recursive: true,
    filter: (source) => {
      const top = relative(fixturePath, source).split(sep)[0];
      return top !== "node_modules" && top !== ".smarttest";
    },
  });
  symlinkSync(join(fixturePath, "node_modules"), join(directory, "node_modules"), "dir");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.email=extension-test@example.invalid",
    "-c",
    "user.name=SmartTest extension test",
    "commit",
    "-qm",
    "fixture",
  );
  appendFileSync(
    join(directory, "src", "core", "Labeler.ts"),
    "\n// modified by the extension smoke test\n",
  );
  return directory;
}

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!available)("real smarttest CLI", () => {
  it("scans and dumps the graph through the extension runner", async () => {
    const [scan, graph] = await Promise.all([call(scanArgs()), call(graphArgs())]);
    expect(parseScanJson(scan.stdout).tests.total).toBeGreaterThan(0);
    expect(parseGraphDump(graph.stdout).nodes.length).toBeGreaterThan(0);
  });

  it("explains a symbol and builds truthful protections for a whole file", async () => {
    const graph = parseGraphDump((await call(graphArgs())).stdout);
    const scan = parseScanJson((await call(scanArgs())).stdout);
    const analysis = await analyzeFile({
      file: "src/core/Labeler.ts",
      graph,
      scan,
      maxUnits: 50,
      concurrency: 2,
      signal: new AbortController().signal,
      explain: async (unit) =>
        parseExplainJson(
          (await call(explainArgs(explainTarget("src/core/Labeler.ts", unit.qualifiedName))))
            .stdout,
        ),
    });
    expect(analysis.protections.length).toBeGreaterThan(0);
    expect(analysis.truncated).toBe(false);
    expect(
      analysis.protections.some(
        (protection) =>
          protection.qualifiedName === "Labeler.label" && protection.state === "protected",
      ),
    ).toBe(true);
    expect(analysis.protections.every((protection) => protection.reason.length > 0)).toBe(true);
    expect(analysis.units.map((unit) => unit.qualifiedName)).toContain("Labeler.label");
  });

  it("runs impact and an affected test run in a temporary git copy", async () => {
    const directory = copyFixture();
    temporary.push(directory);
    const options = { mode: "balanced", changeSource: "uncommitted" } as const;
    const impact = parseImpactJson((await call(impactArgs(options), directory)).stdout);
    expect(impact.changeSet.changes).toContainEqual({
      type: "modified",
      path: "src/core/Labeler.ts",
    });
    expect(impact.decision.selectedTests.length).toBeGreaterThan(0);

    const result = parseRunJson((await call(runAffectedArgs(options), directory, 120_000)).stdout);
    expect(result.report.summary.executed).toBeGreaterThan(0);
    expect(result.report.summary.passed).toBeGreaterThan(0);
    expect(result.report.summary.cached).toBe(0);
    expect(result.report.executions.some((execution) => execution.status === "passed")).toBe(true);
    expect(result.integrityIssues).toEqual([]);
  });
});
