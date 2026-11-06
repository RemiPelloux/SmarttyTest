/**
 * @smarttest/adapter-phpunit — PHPUnit and Pest (preview), through `php artisan test` when the
 * project runs its tests that way.
 *
 * - Discovery: `--list-tests-xml` lists the test classes PHPUnit collects from `phpunit.xml`
 *   (its test suites, folders, suffixes, exclusions and excluded groups) with their files.
 * - Execution: the selected files are given to the runner (in batches that fit a command line);
 *   results come from `--log-junit`. The project's own logging and result cache are turned off
 *   (`--no-logging`, `--do-not-cache-result`): SmartTest writes nothing in the project.
 * - A fatal error, a selected file PHPUnit ran no test from, or "No tests executed" is a
 *   failure, never a pass. When PHPUnit fails the run without a failing test (a risky test or a
 *   warning with `failOnRisky`/`failOnWarning`), the tests its event log names fail; otherwise
 *   the run fails as a whole.
 *
 * The PHP binary: `SMARTTEST_PHP`, the configured `php.binary`, then `php` on PATH.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExecutionOptions,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
  toPosix,
} from "@smarttest/shared";

export interface PhpUnitAdapterOptions {
  projectRoot: string;
  /** Directory the runner starts in (the Composer project's root). */
  cwd: string;
  /** Project-relative PHPUnit configuration (`phpunit.xml`), when it is not the default one. */
  configFile?: string;
  /** PHP binary configured in `php.binary`. */
  binary?: string;
}

/** The PHP binary a project runs its tests with. */
export function phpBinary(cwd: string, configured?: string): string {
  const explicit = process.env.SMARTTEST_PHP || configured;
  // A bare command (`php`, `php8.3`) is looked up on PATH; a relative path (`bin/php`) is the
  // project's.
  if (explicit)
    return isAbsolute(explicit) || !/[\\/]/.test(explicit) ? explicit : resolve(cwd, explicit);
  return "php";
}

export type PhpRunnerKind = "artisan" | "pest" | "phpunit";

/**
 * How the project runs its tests: `php artisan test` when a Composer script does, else Pest when
 * it is installed, else PHPUnit.
 */
export function phpRunnerKind(cwd: string): PhpRunnerKind {
  let scripts = "";
  try {
    const json = JSON.parse(readFileSync(join(cwd, "composer.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = JSON.stringify(json.scripts ?? {});
  } catch {
    scripts = "";
  }
  if (existsSync(join(cwd, "artisan")) && /artisan\s+test\b/.test(scripts)) return "artisan";
  if (existsSync(join(cwd, "vendor", "bin", "pest"))) return "pest";
  return "phpunit";
}

const CAPABILITIES: TestAdapterCapabilities = {
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

const env = (extra?: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  // Xdebug slows every test several times over; a project that wants it sets XDEBUG_MODE.
  XDEBUG_MODE: process.env.XDEBUG_MODE ?? "off",
  NO_COLOR: "1",
  ...extra,
});

function missing(php: string, message: string): SmartTestError {
  return new SmartTestError(
    `${php} could not run the tests: ${message.trim().split("\n").slice(-3).join(" ")}`,
    {
      code: "ST_RUNNER_MISSING",
      category: "infrastructure",
      hint: 'Install PHP and the project\'s Composer dependencies (`composer install`), or point SmartTest at PHP: `php: { binary: "/usr/bin/php8.3" }` in smarttest.config, or SMARTTEST_PHP.',
    },
  );
}

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) =>
  xmlText(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "");

const shortClass = (cls: string) => cls.slice(cls.lastIndexOf("\\") + 1);

/** One test result of PHPUnit's JUnit XML, with the class it belongs to. */
export interface PhpUnitResult extends TestExecution {
  className: string;
  method: string;
}

/**
 * Parses PHPUnit's (or Pest's) JUnit XML. `rel` turns the absolute `file` of a test case into a
 * project-relative path.
 */
export function parsePhpUnitJunit(xml: string, rel: (file: string) => string): PhpUnitResult[] {
  const out: PhpUnitResult[] = [];
  // The file of the enclosing suite, for runners that leave it off the test case.
  const suites: { at: number; file: string }[] = [];
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g))
    suites.push({ at: m.index ?? 0, file: attr(m[1] as string, "file") });
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = m[1] as string;
    const body = m[3] ?? "";
    const name = attr(tag, "name");
    const className = attr(tag, "class") || attr(tag, "classname").replace(/\./g, "\\");
    let file = attr(tag, "file");
    if (!file) {
      const at = m.index ?? 0;
      for (let i = suites.length - 1; i >= 0; i--)
        if ((suites[i] as { at: number }).at < at && (suites[i] as { file: string }).file) {
          file = (suites[i] as { file: string }).file;
          break;
        }
    }
    if (!file) continue;
    const f = rel(file);
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(
      body,
    );
    const skipped = /<skipped\b/.test(body);
    const status: TestExecution["status"] = failure ? "failed" : skipped ? "skipped" : "passed";
    const method = name.replace(/ with data set .*$/, "");
    const exec: PhpUnitResult = {
      testId: `${f}::${className ? `${shortClass(className)}::` : ""}${name}`,
      status,
      durationMs: Math.round(Number(attr(tag, "time") || 0) * 1000),
      attempts: 1,
      className,
      method,
    };
    if (failure)
      exec.error = {
        message: xmlText(
          `${attr(failure[2] ?? failure[5] ?? "", "type")}\n${failure[3] ?? ""}`.trim(),
        ).slice(0, 4000),
      };
    out.push(exec);
  }
  return out;
}

/** Files of the test classes listed by `--list-tests-xml` (PHPUnit 10+). */
export function parseListTestsXml(xml: string): { files: string[]; classes: string[] } {
  const files = new Set<string>();
  const classes = new Set<string>();
  for (const m of xml.matchAll(/<(testClass|testCaseClass|phpt)\b([^>]*)>?/g)) {
    const tag = m[2] as string;
    const file = attr(tag, "file");
    if (file) files.add(file);
    const name = attr(tag, "name");
    if (name && !file) classes.add(name);
  }
  return { files: [...files], classes: [...classes] };
}

/**
 * The tests PHPUnit's event log (`--log-events-text`) says made the run fail without failing:
 * risky tests and the warnings, notices and deprecations the configuration fails on.
 */
export function failingEvents(events: string, config: string): { test: string; reason: string }[] {
  const on = (name: string, dflt = false) => {
    const m = new RegExp(`\\b${name}="(true|false)"`).exec(config);
    return m ? m[1] === "true" : dflt;
  };
  const kinds: [RegExp, string][] = [];
  if (on("failOnRisky")) kinds.push([/^Test Considered Risky$/, "risky"]);
  if (on("failOnWarning"))
    kinds.push([/^Test Triggered (?:PHP |PHPUnit )?Warning$/, "it triggered a warning"]);
  if (on("failOnNotice")) kinds.push([/^Test Triggered (?:PHP )?Notice$/, "it triggered a notice"]);
  if (on("failOnDeprecation"))
    kinds.push([/^Test Triggered (?:PHP |PHPUnit )?Deprecation$/, "it triggered a deprecation"]);
  const out: { test: string; reason: string }[] = [];
  const lines = events.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[[^\]]*\](?: \[[^\]]*\])? (Test [A-Za-z ]+?) \((.+)\)\s*$/.exec(lines[i] ?? "");
    if (!m) continue;
    const kind = kinds.find(([re]) => re.test(m[1] as string));
    if (!kind) continue;
    const detail: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j] ?? ""); j++)
      detail.push((lines[j] as string).trim());
    out.push({
      test: m[2] as string,
      reason: `PHPUnit failed the run: ${kind[1]}${detail.length ? ` — ${detail.join(" ").slice(0, 500)}` : ""}`,
    });
  }
  return out;
}

/** Splits arguments into batches whose command line stays under the platform's limit. */
export function batches(files: readonly string[], limit: number): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const f of files) {
    if (current.length && size + f.length + 1 > limit) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.length + 1;
  }
  if (current.length) out.push(current);
  return out;
}

export class PhpUnitAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "phpunit";
  constructor(private readonly options: PhpUnitAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return CAPABILITIES;
  }

  private php(): string {
    return phpBinary(this.options.cwd, this.options.binary);
  }

  private rel(file: string): string {
    const abs = isAbsolute(file) ? file : join(this.options.cwd, file);
    return toPosix(relative(this.options.projectRoot, abs));
  }

  private configArgs(): string[] {
    const c = this.options.configFile;
    // One argument: `php artisan test` replaces a `--configuration=` it is given with its own.
    return c
      ? [
          `--configuration=${toPosix(relative(this.options.cwd, join(this.options.projectRoot, c)))}`,
        ]
      : [];
  }

  private configText(): string {
    const c = this.options.configFile;
    for (const f of c
      ? [join(this.options.projectRoot, c)]
      : ["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"].map((x) =>
          join(this.options.cwd, x),
        ))
      try {
        return readFileSync(f, "utf8");
      } catch {
        // next
      }
    return "";
  }

  /** The command that runs tests: `[script, …args]` after the PHP binary. */
  private runner(kind: PhpRunnerKind = phpRunnerKind(this.options.cwd)): string[] {
    if (kind === "artisan") return ["artisan", "test"];
    const bin = kind === "pest" ? "pest" : "phpunit";
    const local = join("vendor", "bin", bin);
    if (!existsSync(join(this.options.cwd, local)))
      throw missing(this.php(), `${local} is not installed (run \`composer install\`)`);
    return [toPosix(local)];
  }

  private async spawn(args: string[], extra: ExecutionOptions | undefined, timeoutMs: number) {
    const php = this.php();
    try {
      return await runProcess(php, args, {
        cwd: this.options.cwd,
        env: env(extra?.env),
        ...(extra?.timeoutMs ? { timeoutMs: extra.timeoutMs } : { timeoutMs }),
        ...(extra?.signal ? { signal: extra.signal } : {}),
      });
    } catch (error) {
      throw missing(php, (error as Error).message);
    }
  }

  async discover(): Promise<TestCase[]> {
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-phpunit-"));
    const out = join(tmp, "tests.xml");
    try {
      // `php artisan test` is PHPUnit (or Pest) underneath: list with the runner itself.
      const kind = phpRunnerKind(this.options.cwd);
      const pest = existsSync(join(this.options.cwd, "vendor", "bin", "pest"));
      const runner = this.runner(kind === "artisan" ? (pest ? "pest" : "phpunit") : kind);
      const res = await this.spawn(
        [...runner, ...this.configArgs(), "--do-not-cache-result", "--list-tests-xml", out],
        undefined,
        300_000,
      );
      const xml = await readFile(out, "utf8").catch(() => "");
      if (!xml) {
        const text = `${res.stdout}\n${res.stderr}`;
        if (/Could not open input file|not found|command not found/i.test(text))
          throw missing(this.php(), text);
        throw new SmartTestError(
          `PHPUnit could not list the tests: ${text.trim().split("\n").slice(-8).join("\n")}`,
          { code: "ST_DISCOVERY_FAILED", category: "infrastructure" },
        );
      }
      const listed = parseListTestsXml(xml);
      let files = listed.files.map((f) => this.rel(f));
      // PHPUnit 10 lists classes without their files: ask for the files.
      if (!files.length && listed.classes.length) {
        const text = await this.spawn(
          [...runner, ...this.configArgs(), "--do-not-cache-result", "--list-test-files"],
          undefined,
          300_000,
        );
        files = text.stdout
          .split("\n")
          .map((l) => l.trim().replace(/^- /, ""))
          .filter(
            (l) => l.endsWith(".php") && (isAbsolute(l) || existsSync(join(this.options.cwd, l))),
          )
          .map((l) => this.rel(l));
      }
      return [...new Set(files)]
        .sort()
        .map((f) => ({ id: f, filePath: f, suitePath: [], name: f, tags: [] }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-phpunit-"));
    const runner = this.runner();
    const config = this.configText();
    const byCwd = new Map<string, string>();
    for (const f of selection.files)
      byCwd.set(toPosix(relative(this.options.cwd, join(this.options.projectRoot, f))), f);
    const executions: TestExecution[] = [];
    const outputs: string[] = [];
    let exitCode: number | null = 0;
    let timedOut = false;
    let cancelled = false;
    try {
      const limit = process.platform === "win32" ? 24_000 : 120_000;
      for (const [n, chunk] of batches([...byCwd.keys()], limit).entries()) {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        const junit = join(tmp, `junit-${n}.xml`);
        const events = join(tmp, `events-${n}.txt`);
        // `php artisan test` passes its own configuration (phpunit.xml, else phpunit.xml.dist)
        // and colours to PHPUnit, and refuses them twice.
        const artisan = runner[0] === "artisan";
        const res = await this.spawn(
          [
            ...runner,
            ...(artisan ? ["--no-ansi"] : [...this.configArgs(), "--colors=never"]),
            "--no-logging",
            "--do-not-cache-result",
            "--log-junit",
            junit,
            "--log-events-text",
            events,
            ...chunk,
          ],
          options,
          0,
        );
        timedOut ||= res.timedOut;
        cancelled ||= res.cancelled;
        const output = `${res.stdout}\n${res.stderr}`.trim();
        outputs.push(output);
        const xml = await readFile(junit, "utf8").catch(() => "");
        const results = parsePhpUnitJunit(xml, (f) => this.rel(f));
        let code = res.code;
        // Failed without a failing test: the tests the event log names (risky, warnings).
        if (code !== 0 && !results.some((r) => r.status === "failed") && !res.timedOut) {
          const named = failingEvents(await readFile(events, "utf8").catch(() => ""), config);
          let attributed = 0;
          for (const ev of named) {
            const [cls, rest = ""] = ev.test.split("::") as [string, string?];
            const method = rest.replace(/#.*$/, "").replace(/ with data set .*$/, "");
            for (const r of results)
              if (r.className === cls && r.method === method) {
                r.status = "failed";
                r.error = { message: ev.reason };
                attributed++;
              }
          }
          if (attributed) code = 0;
        }
        if (code !== 0 && code !== 1) exitCode = code;
        else if (code === 1 && !results.some((r) => r.status === "failed")) exitCode = 1;
        for (const r of results) {
          const { className: _c, method: _m, ...exec } = r;
          executions.push(exec);
        }
        // A selected file PHPUnit ran no test from is never a pass.
        const seen = new Set(results.map((r) => r.testId.slice(0, r.testId.indexOf("::"))));
        for (const rel of chunk) {
          const file = byCwd.get(rel) as string;
          if (seen.has(file)) continue;
          executions.push({
            testId: `${file}::(collection)`,
            status: "failed",
            durationMs: 0,
            attempts: 1,
            error: {
              message:
                (res.code === 0 || /No tests executed/i.test(output)
                  ? "PHPUnit ran no test from this file"
                  : output.split("\n").slice(-20).join("\n")) ||
                "PHPUnit reported no result for this file",
            },
          });
        }
        if (res.timedOut || res.cancelled) break;
      }
      const result: TestRunResult & { meta?: Record<string, unknown> } = {
        adapter: this.id,
        executions,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      result.meta = {
        exitCode,
        timedOut,
        cancelled,
        output: outputs.join("\n").slice(-3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
