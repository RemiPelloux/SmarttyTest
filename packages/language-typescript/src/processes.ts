import { posix } from "node:path";
import type { ImportRecord } from "@smarttest/source-parser";
import ts from "typescript";
import type { StaticPathEvaluator } from "./static-path.js";

/**
 * Scripts run in another thread or process: `new Worker(url)`, `fork(path)`,
 * `spawn(process.execPath, [script])`, `execFile("tsx", [script])`, `exec("node scripts/x.mjs")`.
 * The script (and what it imports) is a dependency of the calling file, like an import.
 */

const PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "execa",
  "cross-spawn",
]);

/** Functions whose first argument is a script path. */
const SCRIPT_FIRST = new Set(["fork", "execaNode", "Worker", "SharedWorker"]);
/** Functions taking a command and an argument array. */
const COMMAND_AND_ARGS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
]);
/** Functions taking a whole command line. */
const COMMAND_LINE = new Set(["exec", "execSync", "execaCommand", "execaCommandSync"]);

/** Commands that run a JavaScript or TypeScript file given as their first operand. */
const SCRIPT_RUNNERS = new Set([
  "node",
  "nodejs",
  "tsx",
  "ts-node",
  "ts-node-esm",
  "vite-node",
  "babel-node",
  "bun",
  "deno",
]);
/** Package runners whose first operand is the command (`npx tsx script.ts`). */
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
/** Flags followed by a separate value. */
const VALUE_FLAGS = new Set([
  "--import",
  "-r",
  "--require",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "-C",
  "--conditions",
  "--input-type",
  "--title",
  "--tsconfig",
  "-P",
  "--project",
]);
/** Flags taking inline code: no script file. */
const CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

export type ScriptRun =
  /** The script path, relative to the calling file's directory (may contain `*`). */
  | { pattern: string }
  /** A script runs, but its path cannot be worked out. */
  | { unresolved: true };

const commandName = (s: string) =>
  posix.basename(s.replace(/\\/g, "/")).replace(/\.(exe|cmd)$/i, "");

export class ProcessScripts {
  /** Local name -> function name, for names imported from a process module. */
  private readonly fns = new Map<string, string>();
  /** Local names bound to a process module object. */
  private readonly modules = new Set<string>();
  private readonly dir: string;

  constructor(
    imports: readonly ImportRecord[],
    private readonly sf: ts.SourceFile,
    path: string,
    private readonly paths: StaticPathEvaluator,
  ) {
    this.dir = posix.dirname(path);
    for (const imp of imports) {
      if (!PROCESS_MODULES.has(imp.specifier)) continue;
      for (const b of imp.bindings) {
        if (b.imported === "default" && imp.specifier === "cross-spawn")
          this.fns.set(b.local, "spawn");
        else if (b.imported === "default" && imp.specifier === "execa")
          this.fns.set(b.local, "execa");
        else if (b.imported === "*" || b.imported === "default") this.modules.add(b.local);
        else this.fns.set(b.local, b.imported);
      }
    }
  }

  private calleeName(callee: ts.Expression, isNew: boolean): string | undefined {
    if (ts.isIdentifier(callee)) {
      const f = this.fns.get(callee.text);
      if (f) return f;
      // Browser and Vite workers are globals.
      return isNew && (callee.text === "Worker" || callee.text === "SharedWorker")
        ? callee.text
        : undefined;
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const obj = callee.expression;
    if (ts.isIdentifier(obj) && this.modules.has(obj.text)) return callee.name.text;
    // require("node:child_process").spawn(…)
    if (
      ts.isCallExpression(obj) &&
      ts.isIdentifier(obj.expression) &&
      obj.expression.text === "require" &&
      obj.arguments[0] &&
      ts.isStringLiteralLike(obj.arguments[0]) &&
      PROCESS_MODULES.has(obj.arguments[0].text)
    )
      return callee.name.text;
    return undefined;
  }

  /** The script a call runs, or undefined when it runs none (or an ordinary command). */
  scriptOf(n: ts.CallExpression | ts.NewExpression): ScriptRun | undefined {
    const fn = this.calleeName(n.expression, ts.isNewExpression(n));
    if (!fn) return undefined;
    const args = n.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    if (SCRIPT_FIRST.has(fn)) {
      const [script, second, third] = args;
      if (!script) return undefined;
      const opts = [second, third].find((a) => a && ts.isObjectLiteralExpression(a));
      if ((fn === "Worker" || fn === "SharedWorker") && opts && this.option(opts, "eval"))
        return undefined; // inline code
      return this.resolve(script, this.option(opts, "cwd"));
    }
    if (COMMAND_AND_ARGS.has(fn)) {
      const [cmd, list, opts] = args;
      if (!cmd || !this.isScriptRunner(cmd)) return undefined;
      if (!list || !ts.isArrayLiteralExpression(list)) return { unresolved: true };
      const options = opts && ts.isObjectLiteralExpression(opts) ? opts : undefined;
      return this.fromOperands(cmd, [...list.elements], options);
    }
    if (COMMAND_LINE.has(fn)) {
      const [line, opts] = args;
      if (!line) return undefined;
      return this.fromCommandLine(
        line,
        opts && ts.isObjectLiteralExpression(opts) ? opts : undefined,
      );
    }
    return undefined;
  }

  private option(opts: ts.Expression | undefined, name: string): ts.Expression | undefined {
    if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
    for (const p of opts.properties) {
      if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
      if (p.name.text !== name) continue;
      if (ts.isPropertyAssignment(p)) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p)) return p.name;
    }
    return undefined;
  }

  private isScriptRunner(cmd: ts.Expression): boolean {
    const text = cmd.getText(this.sf);
    if (text === "process.execPath" || text === "process.argv0" || text === "process.argv[0]")
      return true;
    return ts.isStringLiteralLike(cmd) && SCRIPT_RUNNERS.has(commandName(cmd.text));
  }

  /** The first operand after the runner's flags (`--import tsx`, `-r ts-node/register`…). */
  private fromOperands(
    cmd: ts.Expression,
    els: ts.Expression[],
    options: ts.ObjectLiteralExpression | undefined,
  ): ScriptRun | undefined {
    const runner = ts.isStringLiteralLike(cmd) ? commandName(cmd.text) : "node";
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as ts.Expression;
      if (ts.isSpreadElement(el)) return { unresolved: true };
      const v = ts.isStringLiteralLike(el) ? el.text : undefined;
      if (v?.startsWith("-")) {
        if (CODE_FLAGS.has(v)) return undefined;
        if (VALUE_FLAGS.has(v)) i++;
        continue;
      }
      if (
        v !== undefined &&
        ["bun", "deno", "tsx"].includes(runner) &&
        ["run", "watch"].includes(v)
      )
        continue;
      return this.resolve(el, this.option(options, "cwd"));
    }
    return undefined;
  }

  private fromCommandLine(
    line: ts.Expression,
    options: ts.ObjectLiteralExpression | undefined,
  ): ScriptRun | undefined {
    // Only literal text tells which command runs; anything else is an ordinary command for us.
    const anchoredText = this.paths.evaluateAnchored(line);
    const text = anchoredText ?? this.raw(line);
    if (text === undefined) return undefined;
    const words = text.split(/\s+/).filter(Boolean);
    let i = 0;
    if (words[0] && PACKAGE_RUNNERS.has(commandName(words[0]))) i++;
    const runner = words[i] ? commandName(words[i] as string) : "";
    if (!SCRIPT_RUNNERS.has(runner)) return undefined;
    for (i++; i < words.length; i++) {
      const w = (words[i] as string).replace(/^["']|["']$/g, "");
      if (w.startsWith("-")) {
        if (CODE_FLAGS.has(w)) return undefined;
        if (VALUE_FLAGS.has(w)) i++;
        continue;
      }
      if (["bun", "deno", "tsx"].includes(runner) && ["run", "watch"].includes(w)) continue;
      if (!/[A-Za-z0-9_-]/.test(w.replace(/\*/g, ""))) return { unresolved: true };
      if (anchoredText !== undefined) return { pattern: posix.normalize(w) };
      return this.fromCwd(w, this.option(options, "cwd"));
    }
    return undefined;
  }

  /** Literal text of an expression (template parts unknown become `*`), without path rules. */
  private raw(e: ts.Expression): string | undefined {
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) out += `*${span.literal.text}`;
      return out;
    }
    return undefined;
  }

  /** The initializer of a `const` declared in a block around `id` (`const script = …`). */
  private localConst(id: ts.Identifier): ts.Expression | undefined {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
      for (const stmt of p.statements) {
        if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
          continue;
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === id.text && d.initializer)
            return d.initializer;
      }
    }
    return undefined;
  }

  private resolve(
    script: ts.Expression,
    cwd: ts.Expression | undefined,
    depth = 0,
  ): ScriptRun | undefined {
    if (ts.isIdentifier(script) && depth < 8) {
      const init = this.localConst(script);
      if (init) return this.resolve(init, cwd, depth + 1);
    }
    // A package's own script (`require.resolve("pkg/bin")`) is not project code.
    if (
      ts.isCallExpression(script) &&
      /^(require|import\.meta)\.resolve$/.test(script.expression.getText(this.sf)) &&
      script.arguments[0] &&
      ts.isStringLiteralLike(script.arguments[0]) &&
      !script.arguments[0].text.startsWith(".")
    )
      return undefined;
    const anchored = this.paths.evaluateAnchored(script);
    if (anchored !== undefined) return { pattern: anchored };
    const rel = this.paths.evaluate(script);
    if (rel === undefined) return { unresolved: true };
    return this.fromCwd(rel, cwd);
  }

  /** A path relative to the process's working directory: `cwd` when given, else the project root. */
  private fromCwd(rel: string, cwd: ts.Expression | undefined): ScriptRun {
    if (!/[A-Za-z0-9_-]/.test(rel.replace(/\*/g, ""))) return { unresolved: true };
    if (cwd && cwd.getText(this.sf) !== "process.cwd()") {
      const base = this.paths.evaluateAnchored(cwd, true);
      if (base === undefined) return { unresolved: true };
      return { pattern: posix.normalize(posix.join(base, rel)) };
    }
    return { pattern: posix.relative(this.dir === "." ? "" : this.dir, rel) || rel };
  }
}
