/**
 * @smarttest/adapter-vitest — runs tests through Vitest itself (spec §15.1). Capabilities are declared, never emulated (ADR-0005).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JestLikeReport, parseJestLikeReport, resolvePackageBin } from "@smarttest/plugin-sdk";
import {
  canonicalPath,
  type ExecutionOptions,
  relPosixReported,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestRunResult,
  type TestSelection,
} from "@smarttest/shared";

export interface VitestAdapterOptions {
  /** Absolute project root (test ids are relative to it). */
  projectRoot: string;
  /** Absolute directory the runner executes from (its config is auto-detected there). */
  cwd: string;
  configFile?: string;
  /** Where coverage JSON should be written when coverage is requested. */
  coverageDir?: string;
}

export class VitestAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "vitest";
  constructor(private readonly options: VitestAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: true,
      fileSelection: true,
      testCaseSelection: false,
      coverage: true,
      tracing: false,
      parallel: true,
      cancellation: true,
      retry: false,
      sourceMaps: true,
    };
  }

  private bin(): string {
    const bin = resolvePackageBin(this.options.cwd, "vitest", "vitest");
    if (!bin) {
      throw new SmartTestError(`Vitest is not installed in ${this.options.cwd}`, {
        code: "ST_RUNNER_MISSING",
        category: "infrastructure",
        hint: "Install it (e.g. `npm i -D vitest`) or set `adapters` in smarttest.config.",
      });
    }
    return bin;
  }

  /**
   * Discovery and execution read the same config: a second config in one folder (a Stryker
   * config next to the main one) collects other files than the default config does.
   */
  private configArgs(): string[] {
    const file = this.options.configFile;
    // A workspace file lists projects, it is not a config: Vitest 3 finds it on its own, and
    // Vitest 4+ no longer reads it (projects live in `test.projects`). Never pass it as --config.
    if (!file || /(?:^|\/)vitest\.workspace\.[cm]?[jt]s(?:on)?$/.test(file)) return [];
    return ["--config", join(this.options.projectRoot, file)];
  }

  async discover(): Promise<TestCase[]> {
    const res = await runProcess(
      process.execPath,
      [this.bin(), "list", "--json", "--filesOnly", ...this.configArgs()],
      {
        cwd: canonicalPath(this.options.cwd),
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        timeoutMs: 120_000,
      },
    );
    const start = res.stdout.indexOf("[");
    if (res.code !== 0 || start === -1) {
      throw new SmartTestError(
        `vitest discovery failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        {
          code: "ST_DISCOVERY_FAILED",
          category: "infrastructure",
        },
      );
    }
    const raw = JSON.parse(res.stdout.slice(start)) as (
      | string
      | { file?: string; name?: string }
    )[];
    const files = [
      ...new Set(
        raw.map((x) => (typeof x === "string" ? x : (x.file ?? x.name ?? ""))).filter(Boolean),
      ),
    ];
    return files.map((abs) => {
      const rel = relPosixReported(this.options.projectRoot, abs) ?? abs;
      return { id: rel, filePath: rel, suitePath: [], name: rel, tags: [] };
    });
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-vitest-"));
    const out = join(tmp, "report.json");
    // Canonical: the runner matches these against the canonical paths it found (macOS
    // /private/var, Windows long names); a root spelled through a symlink would match nothing.
    const files = selection.files.map((f) => join(canonicalPath(this.options.projectRoot), f));
    const args = [
      this.bin(),
      "run",
      "--reporter=json",
      // The JSON report has no text for errors outside tests (an unhandled error, a failing
      // hook in a describe block); a console reporter prints them on stderr.
      "--reporter=dot",
      `--outputFile.json=${out}`,
      "--passWithNoTests",
      ...this.configArgs(),
      ...(options.workers ? [`--maxWorkers=${options.workers}`] : []),
      ...(options.trace ? ["--pool=threads"] : []),
      ...(options.coverage && this.options.coverageDir
        ? [
            "--coverage.enabled=true",
            "--coverage.reporter=json",
            // A failing test still ran code: record what it observed (Jest does by default).
            "--coverage.reportOnFailure=true",
            `--coverage.reportsDirectory=${this.options.coverageDir}`,
          ]
        : []),
      ...files,
    ];
    try {
      const res = await runProcess(process.execPath, args, {
        // Canonical like the file filters: Windows keeps a short-name cwd (RUNNER~1) as given.
        cwd: canonicalPath(this.options.cwd),
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...options.env },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let report: JestLikeReport | undefined;
      try {
        report = JSON.parse(await readFile(out, "utf8")) as JestLikeReport;
      } catch {
        report = undefined;
      }
      const executions = report ? parseJestLikeReport(report, this.options.projectRoot) : [];
      for (const e of executions)
        if (e.testId.endsWith("::(suite)") && e.error?.message.includes("gave no message")) {
          const printed = vitestFailedSuiteText(res.stderr, e.testId.slice(0, -"::(suite)".length));
          if (printed) e.error = { message: printed };
        }
      const finishedAt = new Date().toISOString();
      const result: TestRunResult & { meta?: Record<string, unknown> } = {
        adapter: this.id,
        executions,
        startedAt,
        finishedAt,
      };
      result.meta = {
        exitCode: res.code,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        stderr: report ? "" : (res.stderr || res.stdout).slice(-4000),
        // Vitest exits 1 for an unhandled error while its report says `success: true` and every
        // test passed: the exit code and this text are all that is left of it.
        output: (res.stderr || res.stdout).slice(0, 3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * The error a console reporter printed for a file that failed outside its tests (` FAIL  <file> >
 * <suite>` blocks on stderr). The JSON report leaves the message empty for a hook that throws
 * inside a describe block. Exported for tests.
 */
export function vitestFailedSuiteText(stderr: string, file: string): string | undefined {
  const blocks: string[] = [];
  for (const block of stderr.split(/^ *FAIL +/m).slice(1)) {
    const shown = /^(\S+)/.exec(block)?.[1];
    if (!shown || !(shown === file || file.endsWith(`/${shown}`))) continue;
    blocks.push(`FAIL ${block.split(/^⎯/m)[0]?.trimEnd()}`);
  }
  return blocks.length ? blocks.join("\n\n").slice(0, 4000) : undefined;
}
