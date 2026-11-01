/**
 * @smarttest/adapter-node — runs tests through Node's built-in runner (`node --test`).
 * Results come from the JUnit reporter, which records the file of every test case.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  canonicalPath,
  type ExecutionOptions,
  findNodeTestScript,
  type NodeTestCommand,
  readPackageScripts,
  relPosixReported,
  runProcess,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
  type TestStatus,
  toPosix,
  walkFiles,
} from "@smarttest/shared";
import { expandNodePatterns, nodeStripsTypes } from "@smarttest/test-discovery";

export interface NodeTestAdapterOptions {
  projectRoot: string;
  cwd: string;
  /** Patterns from `node --test <patterns>`; defaults to Node's own defaults. */
  patterns?: string[];
  /**
   * The project's `node --test` command; read from the first package.json script in `cwd` that
   * runs one when omitted (`null`: none). See `NodeTestAdapter.scriptFlags`.
   */
  command?: NodeTestCommand | null;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g))
    out[m[1] as string] = decode(m[2] as string);
  return out;
}

/** Parses Node's JUnit reporter output (nested <testsuite>, <testcase file="…">). */
export function parseNodeJUnit(xml: string, projectRoot: string): TestExecution[] {
  const out: TestExecution[] = [];
  const suites: string[] = [];
  const re = /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>|<(failure|skipped|error)\b([^>]*?)(\/?)>/g;
  let current: { exec: TestExecution; file: string } | undefined;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex scanning loop
  while ((m = re.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClosing, child, childAttrs] = m;
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attrs(rawAttrs ?? "").name ?? "");
      continue;
    }
    if (tag === "testcase") {
      if (closing) {
        current = undefined;
        continue;
      }
      const a = attrs(rawAttrs ?? "");
      const file = a.file
        ? (relPosixReported(projectRoot, a.file) ?? toPosix(relative(projectRoot, a.file)))
        : "(unknown)";
      const name = [...suites, a.name ?? ""].filter(Boolean).join(" ");
      const exec: TestExecution = {
        testId: `${file}::${name}`,
        status: "passed",
        durationMs: Math.round(Number(a.time ?? 0) * 1000),
        attempts: 1,
      };
      out.push(exec);
      current = selfClosing ? undefined : { exec, file };
      continue;
    }
    if (child && current) {
      const a = attrs(childAttrs ?? "");
      if (child === "skipped")
        current.exec.status = (a.type === "todo" ? "pending" : "skipped") as TestStatus;
      else {
        current.exec.status = "failed";
        const end = xml.indexOf(`</${child}>`, re.lastIndex);
        const body = end > -1 ? xml.slice(re.lastIndex, end) : "";
        current.exec.error = {
          message: decode(`${a.message ?? ""}\n${body}`)
            .trim()
            .slice(0, 4000),
        };
      }
    }
  }
  return out;
}

/**
 * A file path as a `node --test` argument. From Node 21 every argument is a glob, so
 * `test/[id].test.js` would run `test/i.test.js`. Each glob character becomes a one-character
 * class (`[` → `[[]`), the only escape Node's glob honours (it reads `\` as a path separator).
 * Brace expansion runs before classes are parsed, so in a path with a brace the `,` and `..` that
 * would expand it become `?`. The runner adapters always run the Node that runs SmartTest, so
 * `nodeMajor` is that version; before 21 arguments are plain paths.
 */
export function nodeTestFileArg(
  path: string,
  nodeMajor = Number(process.versions.node.split(".")[0]),
): string {
  if (nodeMajor < 21) return path;
  const escaped = path.replace(/[[\]*?(){}]/g, (c) => `[${c}]`);
  return /[{}]/.test(path) ? escaped.replace(/,/g, "?").replace(/\.\./g, ".?") : escaped;
}

export class NodeTestAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "node";
  constructor(private readonly options: NodeTestAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: true,
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: false,
      parallel: true,
      cancellation: true,
      retry: false,
      sourceMaps: false,
    };
  }

  private command(): NodeTestCommand | undefined {
    if (this.options.command !== undefined) return this.options.command ?? undefined;
    return findNodeTestScript(readPackageScripts(this.options.cwd))?.command;
  }

  /**
   * What the project's own `node --test` script adds to the run, so tests that need a preload
   * run as they do with `npm test`: every node option of the command (`--import tsx`,
   * `--require ./setup.cjs`, `--env-file`, `--conditions`, `--experimental-*`,
   * `--test-concurrency`, `--test-timeout`…) and the variables set before it (`NODE_OPTIONS=…`,
   * `TZ=UTC`). Not passed: the file/glob arguments (SmartTest gives the selected files), and the
   * options SmartTest sets or that change what a selected run means: `--test-name-pattern`,
   * `--test-skip-pattern`, `--test-only`, reporters and their destinations, `--test-shard`,
   * `--watch`, coverage options, `--test-update-snapshots` and the inspector. `--workers` replaces
   * the script's `--test-concurrency`.
   */
  scriptFlags(workers?: number): { args: string[]; env: Record<string, string> } {
    const command = this.command();
    if (!command) return { args: [], env: {} };
    const args = workers
      ? command.nodeArgs.filter((a) => !/^--test-concurrency(?:=|$)/.test(a))
      : command.nodeArgs;
    return { args, env: command.env };
  }

  async discover(): Promise<TestCase[]> {
    // The script's flags decide whether this Node runs TypeScript test files.
    const script = this.scriptFlags();
    const flags = [...script.args, script.env.NODE_OPTIONS ?? ""].join(" ");
    const strip = /--no-experimental-strip-types\b/.test(flags)
      ? false
      : /--experimental-(?:strip|transform)-types\b/.test(flags) || nodeStripsTypes();
    const patterns = expandNodePatterns(this.options.patterns, strip);
    const files = await walkFiles(this.options.cwd, { include: patterns });
    return files.map((f) => {
      const rel = relPosixReported(this.options.projectRoot, join(this.options.cwd, f)) ?? f;
      return { id: rel, filePath: rel, suitePath: [], name: rel, tags: [] };
    });
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-node-"));
    const out = join(tmp, "junit.xml");
    const script = this.scriptFlags(options.workers);
    try {
      const args = [
        ...script.args,
        "--test",
        "--test-reporter=junit",
        `--test-reporter-destination=${out}`,
        ...(options.workers ? [`--test-concurrency=${options.workers}`] : []),
        ...selection.files.map((f) =>
          nodeTestFileArg(join(canonicalPath(this.options.projectRoot), f)),
        ),
      ];
      const res = await runProcess(process.execPath, args, {
        // Canonical like the file filters: Windows keeps a short-name cwd (RUNNER~1) as given.
        cwd: canonicalPath(this.options.cwd),
        env: {
          ...process.env,
          ...script.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ...options.env,
        },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const xml = await readFile(out, "utf8").catch(() => "");
      const executions = xml ? parseNodeJUnit(xml, this.options.projectRoot) : [];
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
        stderr: executions.length ? "" : (res.stderr || res.stdout).slice(-4000),
        output: (res.stderr || res.stdout).slice(0, 3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
