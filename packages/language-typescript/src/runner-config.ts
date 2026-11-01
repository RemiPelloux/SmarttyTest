/**
 * Static reading of the files a test runner loads because its configuration names them: setup
 * files, global setup/teardown, environments, support files, module mappers and aliases, and the
 * local modules the configuration itself imports. Nothing is executed: a value that is not a
 * literal (or one of the usual path-building calls) is reported as computed, never guessed.
 */
import { readNodeTestCommand } from "@smarttest/shared";
import ts from "typescript";

export type RunnerKind = "vitest" | "jest" | "node" | "playwright" | "cypress";

/** A path as written in the configuration. */
export interface ConfigPath {
  path: string;
  /**
   * What the path is relative to: the configuration file's directory (`__dirname`,
   * `import.meta.url`, `require.resolve`) or the runner's own root (`root`, `<rootDir>`).
   */
  base: "config" | "runner";
}

export interface ConfigLoadedFile extends ConfigPath {
  /** The configuration key that names it (`setupFiles`, `globalSetup`, `supportFile`…). */
  key: string;
}

export interface ConfigMapping {
  /** `moduleNameMapper` (Jest) or `alias` (Vitest). */
  key: string;
  /** Exact specifier (Vitest string alias) or regular-expression source (Jest, Vitest regex). */
  find: string;
  regex: boolean;
  target: ConfigPath;
}

export interface RunnerConfigFacts {
  /** Relative module specifiers the configuration imports or re-exports. */
  imports: string[];
  /** Files the runner loads for its tests because the configuration names them. */
  loads: ConfigLoadedFile[];
  /** Module mappings to local files. */
  mappings: ConfigMapping[];
  /** Jest `rootDir` / Vitest `root`, when set to a static value. */
  root?: ConfigPath;
  /** Keys present in the file (relevant ones only): `supportFile` absent means its default. */
  present: string[];
  /** Keys whose value could not be read statically (`setupFiles: computeSetup()`). */
  computed: string[];
}

const LOADS: Record<RunnerKind, readonly string[]> = {
  vitest: ["setupFiles", "globalSetup"],
  jest: [
    "setupFiles",
    "setupFilesAfterEnv",
    "globalSetup",
    "globalTeardown",
    "testEnvironment",
    "snapshotResolver",
    "testSequencer",
    "resolver",
    "snapshotSerializers",
    "transform",
    "preset",
  ],
  playwright: ["globalSetup", "globalTeardown"],
  cypress: ["supportFile"],
  node: [],
};
const MAPPINGS: Record<RunnerKind, readonly string[]> = {
  vitest: ["alias"],
  jest: ["moduleNameMapper"],
  playwright: [],
  cypress: [],
  node: [],
};
const ROOTS: Record<RunnerKind, readonly string[]> = {
  vitest: ["root"],
  jest: ["rootDir"],
  playwright: [],
  cypress: [],
  node: [],
};

class Computed extends Error {}

/** Reads a runner configuration (TS/JS module or JSON object, such as package.json `jest`). */
export function readRunnerConfig(
  runner: RunnerKind,
  fileName: string,
  text: string,
): RunnerConfigFacts {
  const facts: RunnerConfigFacts = {
    imports: [],
    loads: [],
    mappings: [],
    present: [],
    computed: [],
  };
  const json = /\.json$/i.test(fileName);
  const sf = ts.createSourceFile(
    json ? `${fileName}.ts` : fileName,
    json ? `export default (${text});` : text,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  // Top-level constants, so `setupFiles: setup` with `const setup = ["./a.ts"]` reads statically.
  const consts = new Map<string, ts.Expression>();
  for (const st of sf.statements)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);

  const relative = (s: string) => s.startsWith("./") || s.startsWith("../");
  const loadKeys = new Set(LOADS[runner]);
  const mapKeys = new Set(MAPPINGS[runner]);
  const rootKeys = new Set(ROOTS[runner]);
  const note = (list: string[], key: string) => {
    if (!list.includes(key)) list.push(key);
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      relative(node.moduleSpecifier.text)
    )
      facts.imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      relative(node.arguments[0].text)
    )
      facts.imports.push(node.arguments[0].text);
    const prop = propertyOf(node);
    if (prop) {
      const [key, value] = prop;
      if (loadKeys.has(key) || mapKeys.has(key) || rootKeys.has(key)) note(facts.present, key);
      try {
        if (loadKeys.has(key)) {
          for (const p of paths(value, key === "transform"))
            facts.loads.push({ ...p, key: key === "preset" ? "preset" : key });
        } else if (mapKeys.has(key)) {
          facts.mappings.push(...mappings(key, value));
        } else if (rootKeys.has(key)) {
          const [p] = paths(value, false);
          if (p) facts.root = p;
        }
      } catch (error) {
        if (!(error instanceof Computed)) throw error;
        note(facts.computed, key);
      }
    }
    ts.forEachChild(node, visit);
  };

  /** `key: value` or a shorthand `key` that names a constant. */
  function propertyOf(node: ts.Node): [string, ts.Expression] | undefined {
    if (ts.isPropertyAssignment(node)) {
      const n = node.name;
      const key = ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : undefined;
      return key ? [key, node.initializer] : undefined;
    }
    if (ts.isShorthandPropertyAssignment(node)) return [node.name.text, node.name];
    return undefined;
  }

  function unwrap(e: ts.Expression): ts.Expression {
    let x = e;
    while (
      ts.isParenthesizedExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isSatisfiesExpression(x) ||
      ts.isNonNullExpression(x)
    )
      x = x.expression;
    if (ts.isIdentifier(x) && consts.has(x.text))
      return unwrap(consts.get(x.text) as ts.Expression);
    return x;
  }

  /** Static string parts of a path expression, or Computed. */
  function pathOf(e: ts.Expression): ConfigPath | undefined {
    const x = unwrap(e);
    if (ts.isStringLiteralLike(x)) return { path: x.text, base: "runner" };
    if (x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword)
      return undefined;
    if (ts.isIdentifier(x) && x.text === "undefined") return undefined;
    // new URL("./a.ts", import.meta.url).pathname / fileURLToPath(new URL(...))
    if (ts.isPropertyAccessExpression(x) && x.name.text === "pathname") return pathOf(x.expression);
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "URL") {
      const [a, b] = x.arguments ?? [];
      if (a && ts.isStringLiteralLike(a) && b && isImportMetaUrl(b))
        return { path: a.text, base: "config" };
      throw new Computed();
    }
    if (ts.isCallExpression(x)) {
      const callee = x.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? `${callee.expression.getText(sf)}.${callee.name.text}`
          : "";
      if (/^(?:url\.)?fileURLToPath$/.test(name) && x.arguments[0]) return pathOf(x.arguments[0]);
      if (name === "require.resolve" && x.arguments[0] && ts.isStringLiteralLike(x.arguments[0]))
        return { path: x.arguments[0].text, base: "config" };
      if (/^(?:path\.|posix\.|path\.posix\.)?(?:resolve|join)$/.test(name)) {
        const parts: string[] = [];
        let base: ConfigPath["base"] = "runner";
        x.arguments.forEach((arg, i) => {
          const a = unwrap(arg);
          if (ts.isStringLiteralLike(a)) parts.push(a.text);
          else if (i === 0 && isConfigDir(a)) base = "config";
          else if (i === 0 && /^process\.cwd\(\)$/.test(a.getText(sf))) base = "runner";
          else throw new Computed();
        });
        return { path: parts.join("/") || ".", base };
      }
    }
    if (ts.isTemplateExpression(x)) {
      // `${__dirname}/setup.ts`
      if (isConfigDir(x.templateSpans[0]?.expression) && x.templateSpans.length === 1)
        return {
          path: `.${(x.templateSpans[0] as ts.TemplateSpan).literal.text}`,
          base: "config",
        };
    }
    throw new Computed();
  }

  function isImportMetaUrl(e: ts.Expression): boolean {
    return /^import\.meta\.url$/.test(unwrap(e).getText(sf));
  }
  function isConfigDir(e: ts.Expression | undefined): boolean {
    return !!e && /^(?:__dirname|import\.meta\.dirname)$/.test(unwrap(e).getText(sf));
  }

  /** A path, an array of paths, or (Jest `transform`) an object whose values are paths/tuples. */
  function paths(e: ts.Expression, valuesOfObject: boolean): ConfigPath[] {
    const x = unwrap(e);
    if (ts.isArrayLiteralExpression(x)) {
      const out: ConfigPath[] = [];
      for (const el of x.elements) {
        if (ts.isSpreadElement(el)) throw new Computed();
        const v = unwrap(el);
        // [path, options] tuples (Jest transform, snapshotSerializers with options).
        if (ts.isArrayLiteralExpression(v)) {
          const first = v.elements[0];
          if (first && !ts.isSpreadElement(first)) {
            const p = pathOf(first);
            if (p) out.push(p);
          }
          continue;
        }
        if (ts.isObjectLiteralExpression(v)) continue; // inline options, not a file
        const p = pathOf(v);
        if (p) out.push(p);
      }
      return out;
    }
    if (valuesOfObject && ts.isObjectLiteralExpression(x)) {
      const out: ConfigPath[] = [];
      for (const pr of x.properties) {
        if (!ts.isPropertyAssignment(pr)) throw new Computed();
        out.push(...paths(pr.initializer, false));
      }
      return out;
    }
    if (ts.isObjectLiteralExpression(x)) return []; // e.g. `alias` handled elsewhere
    const p = pathOf(x);
    return p ? [p] : [];
  }

  function mappings(key: string, e: ts.Expression): ConfigMapping[] {
    const x = unwrap(e);
    const out: ConfigMapping[] = [];
    if (ts.isObjectLiteralExpression(x)) {
      for (const pr of x.properties) {
        if (!ts.isPropertyAssignment(pr)) throw new Computed();
        const n = pr.name;
        const find =
          ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)
            ? n.text
            : undefined;
        if (find === undefined) throw new Computed();
        for (const target of paths(pr.initializer, false))
          out.push({ key, find, regex: key === "moduleNameMapper", target });
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(x)) {
      // Vite: [{ find, replacement }]
      for (const el of x.elements) {
        const o = unwrap(el as ts.Expression);
        if (!ts.isObjectLiteralExpression(o)) throw new Computed();
        let find: { text: string; regex: boolean } | undefined;
        let replacement: ConfigPath | undefined;
        for (const pr of o.properties) {
          if (!ts.isPropertyAssignment(pr) || !ts.isIdentifier(pr.name)) throw new Computed();
          const v = unwrap(pr.initializer);
          if (pr.name.text === "find") {
            if (ts.isStringLiteralLike(v)) find = { text: v.text, regex: false };
            else if (ts.isRegularExpressionLiteral(v)) {
              const src = v.text.slice(1, v.text.lastIndexOf("/"));
              find = { text: src, regex: true };
            } else throw new Computed();
          } else if (pr.name.text === "replacement") replacement = pathOf(v);
        }
        if (find && replacement)
          out.push({ key, find: find.text, regex: find.regex, target: replacement });
      }
      return out;
    }
    throw new Computed();
  }

  visit(sf);
  facts.imports = [...new Set(facts.imports)];
  return facts;
}

/**
 * Files a `node --test` script preloads (`--import`, `--require`/`-r`, `--loader`, also inside a
 * `NODE_OPTIONS=` prefix), and whether the command builds its flags in a way that can't be read
 * (a variable or a subshell). The same reading the Node adapter uses to run the command's flags.
 */
export function readNodeTestScript(script: string): {
  loads: ConfigLoadedFile[];
  computed: boolean;
} {
  const command = readNodeTestCommand(script);
  if (!command) return { loads: [], computed: /\$\{?[A-Za-z_]|`|\$\(/.test(script) };
  return {
    loads: command.preloads.map((p) => ({ key: p.flag, path: p.value, base: "runner" })),
    computed: command.computed,
  };
}
