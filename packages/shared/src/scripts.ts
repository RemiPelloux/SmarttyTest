/**
 * Reading the package.json script that runs a test runner, so an adapter runs the runner the way
 * the project does (`node --import tsx --test`, `vitest run --typecheck`). Static only: a part of
 * the command built at run time (`$VAR`, a subshell) is reported as computed and left out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The `scripts` of `<dir>/package.json` ({} when there is none or it can't be read). */
export function readPackageScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The commands of a script (split on `&&`, `||`, `;`, `|` outside quotes), each as its words with
 * quotes removed.
 */
export function scriptCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < script.length) word += script[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < script.length) {
      word += script[++i];
      inWord = true;
    } else if (/\s/.test(c)) endWord();
    else if (c === ";" || c === "|" || (c === "&" && script[i + 1] === "&")) {
      if (c !== ";" && script[i + 1] === c) i++;
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const COMPUTED = /\$\{?[A-Za-z_(]|`/;
/** Commands that run the rest of the line with extra environment variables. */
const ENV_WRAPPERS = new Set(["cross-env", "env", "cross-env-shell"]);

/** Splits a command's leading `NAME=value` assignments (also after `cross-env`/`env`). */
function leadingEnv(words: string[]): { env: Record<string, string>; rest: string[] } {
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i] as string;
    const m = ENV_ASSIGNMENT.exec(w);
    if (m) env[m[1] as string] = m[2] as string;
    else if (!ENV_WRAPPERS.has(w)) break;
  }
  return { env, rest: words.slice(i) };
}

/** Node options that take a value as the next word when written without `=`. */
const NODE_VALUE_FLAGS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--conditions",
  "-C",
  "--input-type",
  "--experimental-default-type",
  "--title",
  "--disable-warning",
  "--localstorage-file",
  "--experimental-config-file",
  "--openssl-config",
  "--icu-data-dir",
  "--redirect-warnings",
  "--unhandled-rejections",
  "--dns-result-order",
  "--diagnostic-dir",
  "--test-concurrency",
  "--test-timeout",
  "--test-isolation",
  "--test-global-setup",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-coverage-include",
  "--test-coverage-exclude",
  "--test-coverage-lines",
  "--test-coverage-branches",
  "--test-coverage-functions",
  "--watch-path",
  "--inspect-port",
]);

/**
 * Node options SmartTest sets itself or that would change what a selected run means: the test
 * filter and reporters, sharding, watch mode, coverage (thresholds would fail a partial run),
 * snapshot updates and the debugger.
 */
const NODE_OWNED_FLAGS =
  /^--(?:test|test-only|test-name-pattern|test-skip-pattern|test-reporter|test-reporter-destination|test-shard|test-update-snapshots|experimental-test-coverage|test-coverage-[a-z-]+|watch|watch-path|watch-preserve-output|inspect|inspect-brk|inspect-wait|inspect-port|debug-port)$/;

export interface NodeTestCommand {
  /** Node options from the command, in order, as `--flag` or `--flag=value` words. */
  nodeArgs: string[];
  /** Environment variables the command sets before `node` (`NODE_OPTIONS='--import tsx'`). */
  env: Record<string, string>;
  /** Files and globs given to `node --test`. */
  patterns: string[];
  /** Modules the command preloads (`--import`, `--require`/`-r`, `--loader`), NODE_OPTIONS included. */
  preloads: { flag: string; value: string }[];
  /** Part of the command is built at run time and was left out. */
  computed: boolean;
}

/**
 * Reads the first `node … --test …` command of a script. Options SmartTest controls (see
 * `NODE_OWNED_FLAGS`) are dropped; every other node option is kept, with its value.
 */
export function readNodeTestCommand(script: string): NodeTestCommand | undefined {
  for (const words of scriptCommands(script)) {
    const { env, rest } = leadingEnv(words);
    // `node` itself, or behind a wrapper (`c8 node --test`, `dotenv -- node --test`).
    const at = rest.findIndex((w) => /(?:^|[/\\])node(?:\.exe)?$/.test(w));
    const args = at === -1 ? [] : rest.slice(at + 1);
    if (!args.includes("--test")) continue;
    const out: NodeTestCommand = {
      nodeArgs: [],
      env: {},
      patterns: [],
      preloads: [],
      computed: false,
    };
    for (const [k, v] of Object.entries(env)) {
      if (COMPUTED.test(v)) out.computed = true;
      else out.env[k] = v;
    }
    const readFlags = (list: string[], keep: boolean) => {
      for (let i = 0; i < list.length; i++) {
        const w = list[i] as string;
        if (COMPUTED.test(w)) {
          out.computed = true;
          continue;
        }
        if (w === "--") {
          if (keep) out.patterns.push(...list.slice(i + 1));
          break;
        }
        if (!w.startsWith("-") || w === "-") {
          if (keep) out.patterns.push(w.replace(/^\.\//, ""));
          continue;
        }
        const eq = w.indexOf("=");
        const flag = eq > 0 ? w.slice(0, eq) : w;
        let value = eq > 0 ? w.slice(eq + 1) : undefined;
        if (value === undefined && NODE_VALUE_FLAGS.has(flag) && i + 1 < list.length)
          value = list[++i] as string;
        if (value !== undefined && COMPUTED.test(value)) {
          out.computed = true;
          continue;
        }
        if (/^(?:--import|--require|-r|--loader|--experimental-loader)$/.test(flag) && value)
          out.preloads.push({ flag, value });
        if (!keep || NODE_OWNED_FLAGS.test(flag)) continue;
        if (value === undefined) out.nodeArgs.push(flag);
        // Node reads `-r x` but not `-r=x`.
        else if (flag.startsWith("--")) out.nodeArgs.push(`${flag}=${value}`);
        else out.nodeArgs.push(flag, value);
      }
    };
    if (out.env.NODE_OPTIONS) readFlags(scriptCommands(out.env.NODE_OPTIONS)[0] ?? [], false);
    readFlags(args, true);
    return out;
  }
  return undefined;
}

/** The first script that runs `node --test` (the one project detection reads), with its name. */
export function findNodeTestScript(
  scripts: Record<string, string>,
): { name: string; command: NodeTestCommand } | undefined {
  for (const [name, script] of Object.entries(scripts)) {
    const command = readNodeTestCommand(script);
    if (command) return { name, command };
  }
  return undefined;
}

/**
 * Whether a script of this package runs Vitest type tests (`vitest --typecheck`,
 * `--typecheck.enabled`). `--typecheck.only` is not followed: it would drop the runtime tests.
 * A script that names another config (`--config other.ts`) runs another Vitest root and is
 * ignored when `configFile` (the root's config, basename compared) is given.
 */
export function vitestScriptTypecheck(
  scripts: Record<string, string>,
  configFile?: string,
): boolean {
  const base = (p: string) => p.replace(/^.*[/\\]/, "");
  for (const script of Object.values(scripts))
    for (const words of scriptCommands(script)) {
      const at = words.findIndex((w) => /(?:^|[/\\])vitest(?:\.mjs)?$/.test(w));
      if (at === -1) continue;
      const args = words.slice(at + 1);
      const typecheck = args.some((w) => /^--typecheck(?:\.enabled)?(?:=true)?$/.test(w));
      if (!typecheck) continue;
      const ci = args.findIndex((w) => w === "--config" || w === "-c" || w.startsWith("--config="));
      if (ci !== -1 && configFile) {
        const w = args[ci] as string;
        const named = w.startsWith("--config=") ? w.slice(9) : args[ci + 1];
        if (named && base(named) !== base(configFile)) continue;
      }
      return true;
    }
  return false;
}
