/**
 * @smarttest/adapter-jest — runs tests through Jest itself (spec §15.1). Capabilities are declared, never emulated (ADR-0005).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JestLikeReport, parseJestLikeReport, resolvePackageBin } from "@smarttest/plugin-sdk";
import {
  type ExecutionOptions,
  relPosix,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestRunResult,
  type TestSelection,
} from "@smarttest/shared";

export interface JestAdapterOptions {
  /** Absolute project root (test ids are relative to it). */
  projectRoot: string;
  /** Absolute directory the runner executes from (its config is auto-detected there). */
  cwd: string;
  configFile?: string;
  /** Where coverage JSON should be written when coverage is requested. */
  coverageDir?: string;
}

export class JestAdapter implements TestAdapter {
  readonly id = "jest";
  constructor(private readonly options: JestAdapterOptions) {}

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
      sourceMaps: "partial",
    };
  }

  private bin(): string {
    const bin = resolvePackageBin(this.options.cwd, "jest", "jest");
    if (!bin) {
      throw new SmartTestError(`Jest is not installed in ${this.options.cwd}`, {
        code: "ST_RUNNER_MISSING",
        category: "infrastructure",
        hint: "Install it (e.g. `npm i -D jest`) or set `adapters` in smarttest.config.",
      });
    }
    return bin;
  }

  async discover(): Promise<TestCase[]> {
    const res = await runProcess(process.execPath, [this.bin(), "--listTests", "--json"], {
      cwd: this.options.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeoutMs: 120_000,
    });
    const start = res.stdout.indexOf("[");
    if (res.code !== 0 || start === -1) {
      throw new SmartTestError(
        `jest discovery failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
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
      const rel = relPosix(this.options.projectRoot, abs) ?? abs;
      return { id: rel, filePath: rel, suitePath: [], name: rel, tags: [] };
    });
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-jest-"));
    const out = join(tmp, "report.json");
    const files = selection.files.map((f) => join(this.options.projectRoot, f));
    const args = [
      this.bin(),
      "--json",
      `--outputFile=${out}`,
      "--passWithNoTests",
      "--ci",
      "--colors=false",
      ...(this.options.configFile
        ? ["--config", join(this.options.projectRoot, this.options.configFile)]
        : []),
      ...(options.workers ? [`--maxWorkers=${options.workers}`] : []),
      ...(options.coverage && this.options.coverageDir
        ? [
            "--coverage",
            "--coverageReporters=json",
            `--coverageDirectory=${this.options.coverageDir}`,
          ]
        : []),
      "--runTestsByPath",
      ...files,
    ];
    try {
      const res = await runProcess(process.execPath, args, {
        cwd: this.options.cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
