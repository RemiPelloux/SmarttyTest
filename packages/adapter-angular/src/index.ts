/**
 * @smarttest/adapter-angular — runs tests through the Angular CLI (`ng test <project>`), the way
 * an Angular project runs them: its unit-test builder compiles the specs with the application's
 * build options, then hands them to Vitest. Running Vitest directly fails on such a project
 * ("describe is not defined"), since nothing compiles or initialises the TestBed.
 *
 * Capabilities are declared, never emulated (ADR-0005). The Karma runner has no machine-readable
 * report: it is refused with a clear error rather than reported from its exit code alone.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { type JestLikeReport, parseJestLikeReport, resolvePackageBin } from "@smarttest/plugin-sdk";
import {
  type AngularTestTarget,
  angularTestTargets,
  canonicalPath,
  type ExecutionOptions,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestRunResult,
  type TestSelection,
} from "@smarttest/shared";

export interface AngularAdapterOptions {
  /** Absolute project root (test ids are relative to it). */
  projectRoot: string;
  /** Absolute workspace directory (where `angular.json` is). */
  cwd: string;
  /** Angular project whose `test` target runs (`ng test <project>`); the only one when unset. */
  project?: string;
  /** The workspace file, relative to the project root (`angular.json`). */
  configFile?: string;
}

export class AngularAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "angular";
  constructor(private readonly options: AngularAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: true,
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: false,
      parallel: false,
      cancellation: true,
      retry: false,
      sourceMaps: false,
    };
  }

  private bin(): string {
    const bin = resolvePackageBin(this.options.cwd, "@angular/cli", "ng");
    if (!bin) {
      throw new SmartTestError(`The Angular CLI is not installed in ${this.options.cwd}`, {
        code: "ST_RUNNER_MISSING",
        category: "infrastructure",
        hint: "Install the project's dependencies (`npm install`); `@angular/cli` runs `ng test`.",
      });
    }
    return bin;
  }

  private async target(): Promise<AngularTestTarget> {
    const file = join(this.options.cwd, "angular.json");
    const text = await readFile(file, "utf8").catch(() => undefined);
    const targets = text ? angularTestTargets(text) : [];
    const target = this.options.project
      ? targets.find((t) => t.project === this.options.project)
      : targets.length === 1
        ? targets[0]
        : undefined;
    if (!target) {
      throw new SmartTestError(
        `No Angular test target${this.options.project ? ` for project "${this.options.project}"` : ""} in ${file}`,
        {
          code: "ST_ANGULAR_TARGET_MISSING",
          category: "configuration",
          hint: 'Name the project in smarttest.config: runners: [{ adapter: "angular", project: "<name>" }].',
        },
      );
    }
    if (target.runner === "karma") {
      throw new SmartTestError(
        `Project "${target.project}" runs its tests with Karma, which SmartTest cannot read results from`,
        {
          code: "ST_ANGULAR_KARMA_UNSUPPORTED",
          category: "configuration",
          hint: 'Karma gives no per-test report. Move the test target to the unit-test builder with Vitest (`ng generate @schematics/angular:refactor-jasmine-vitest`), or set `runner: "vitest"`.',
        },
      );
    }
    return target;
  }

  private projectArgs(target: AngularTestTarget): string[] {
    return ["test", target.project, "--watch=false", "--progress=false"];
  }

  private env(extra?: Record<string, string>): NodeJS.ProcessEnv {
    // NG_CLI_ANALYTICS: never prompt for analytics consent in a non-interactive run.
    return { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", NG_CLI_ANALYTICS: "false", ...extra };
  }

  async discover(): Promise<TestCase[]> {
    const target = await this.target();
    const res = await runProcess(
      process.execPath,
      [this.bin(), ...this.projectArgs(target), "--list-tests"],
      { cwd: canonicalPath(this.options.cwd), env: this.env(), timeoutMs: 120_000 },
    );
    const text = res.stdout;
    const at = text.indexOf("Discovered test files:");
    if (res.code !== 0 || at === -1) {
      throw new SmartTestError(
        `ng test --list-tests failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        { code: "ST_DISCOVERY_FAILED", category: "infrastructure" },
      );
    }
    const files = text
      .slice(at)
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !/\s/.test(l));
    return files.map((f) => {
      const rel = posix.normalize(
        relative(this.options.projectRoot, join(this.options.cwd, f)).split("\\").join("/"),
      );
      return { id: rel, filePath: rel, suitePath: [], name: rel, tags: [] };
    });
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const target = await this.target();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-angular-"));
    const out = join(tmp, "report.json");
    // `--include` is relative to the project's source root; a file path selects that spec.
    const sourceRoot = join(canonicalPath(this.options.cwd), target.sourceRoot);
    const includes = selection.files.map((f) =>
      relative(sourceRoot, join(canonicalPath(this.options.projectRoot), f))
        .split("\\")
        .join("/"),
    );
    const args = [
      this.bin(),
      ...this.projectArgs(target),
      "--reporters=json",
      // The JSON report has no text for a build error or an error outside tests; a console
      // reporter prints it.
      "--reporters=dot",
      `--output-file=${out}`,
      ...includes.flatMap((f) => ["--include", f]),
    ];
    try {
      const res = await runProcess(process.execPath, args, {
        cwd: canonicalPath(this.options.cwd),
        env: this.env(options.env),
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
      const result: TestRunResult & { meta?: Record<string, unknown> } = {
        adapter: this.id,
        executions,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      result.meta = {
        exitCode: res.code,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        // No report: the build failed (a compile error in a spec or in the code it imports).
        stderr: report ? "" : (res.stderr || res.stdout).slice(-4000),
        output: (res.stderr || res.stdout).slice(0, 3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
