/**
 * Module aliases that only a bundler or test-runner configuration declares: Vite/Vitest
 * `resolve.alias` and `test.alias` (object and `{ find, replacement }` array forms, regex finds),
 * Jest `moduleNameMapper` (regexes, `$1` captures, `<rootDir>`, several targets), webpack
 * `resolve.alias` (`name$` exact) and Babel's `module-resolver` `alias`. Read statically with
 * `readRunnerConfig`: a value that is computed is reported, never guessed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type ConfigPath, type RunnerKind, readRunnerConfig } from "./runner-config.js";

export type AliasTool = "vite" | "vitest" | "jest" | "webpack" | "babel";

const EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs"];
/** The configuration files of each tool, in the order the tool looks for them. */
export const ALIAS_CONFIGS: Record<AliasTool, string[]> = {
  vite: EXTS.map((e) => `vite.config.${e}`),
  vitest: EXTS.map((e) => `vitest.config.${e}`),
  jest: [...EXTS.map((e) => `jest.config.${e}`), "jest.config.json", "package.json#jest"],
  webpack: EXTS.map((e) => `webpack.config.${e}`),
  babel: [
    ...EXTS.filter((e) => !e.endsWith("ts")).map((e) => `babel.config.${e}`),
    "babel.config.json",
    ".babelrc",
    ".babelrc.json",
    ...EXTS.filter((e) => !e.endsWith("ts")).map((e) => `.babelrc.${e}`),
    "package.json#babel",
  ],
};
const KIND: Record<AliasTool, RunnerKind> = {
  vite: "vitest",
  vitest: "vitest",
  jest: "jest",
  webpack: "vitest", // `alias` keys, same shapes
  babel: "vitest",
};

export interface AliasRule {
  /** Exact name / prefix (string) or regular-expression source. */
  find: string;
  regex: boolean;
  /** Webpack `name$`: the exact name only. */
  exact: boolean;
  /** Targets tried in order (Jest: an array of paths). */
  targets: ConfigPath[];
}

export interface AliasConfig {
  tool: AliasTool;
  /** Absolute config file (`…/package.json#jest` for a package.json field). */
  file: string;
  dir: string;
  /** Jest `rootDir` / Vite `root`, absolute. */
  root: string;
  rules: AliasRule[];
  /** An alias key whose value can't be read statically. */
  computed: boolean;
  /** Every file read for it (the config and the local modules it imports). */
  inputs: string[];
}

const PROBE = ["", ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Reads a tool's aliases from one configuration file; undefined when the file has none to read. */
export function readAliasConfig(tool: AliasTool, file: string): AliasConfig | undefined {
  const [path, field] = file.split("#") as [string, string | undefined];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const dir = dirname(path);
  const inputs = [path];
  let name = path;
  if (field || /(?:^|[/\\])\.babelrc$/.test(path)) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const value = field ? json[field] : json;
      if (!value || typeof value !== "object") return undefined;
      text = JSON.stringify(value);
      name = `${path}.json`;
    } catch {
      return undefined;
    }
  }
  const mappingKey = tool === "jest" ? "moduleNameMapper" : "alias";
  if (!text.includes(mappingKey) && !/\bimport\b|\brequire\b/.test(text)) return undefined;
  const rules: AliasRule[] = [];
  let computed = false;
  let root: string | undefined;
  // The config and the local modules it imports (`mergeConfig(shared, …)` keeps aliases there).
  const queue = [{ file: path, text, name }];
  const seen = new Set<string>();
  while (queue.length) {
    const next = queue.shift() as { file: string; text: string; name: string };
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    const facts = readRunnerConfig(KIND[tool], next.name, next.text);
    if (facts.computed.includes(mappingKey)) computed = true;
    if (facts.root && next.file === path) {
      const r = materialize(facts.root, dir, dir);
      root = r.abs ?? join(dir, r.spec ?? "");
    }
    for (const m of facts.mappings) {
      if (m.key !== mappingKey) continue;
      const last = rules[rules.length - 1];
      if (last && last.find === m.find && last.regex === m.regex) {
        last.targets.push(m.target);
        continue;
      }
      let find = m.find;
      let regex = m.regex;
      let exact = false;
      if (tool === "webpack" && !regex && find.endsWith("$")) {
        find = find.slice(0, -1);
        exact = true;
      }
      // module-resolver: a key starting with `^` or ending with `$` is a regular expression.
      if (tool === "babel" && !regex && /^\^|\$$/.test(find)) regex = true;
      rules.push({ find, regex, exact, targets: [m.target] });
    }
    for (const spec of facts.imports) {
      const base = join(dirname(next.file), spec);
      const found = PROBE.map((e) => base + e).find((p) => existsSync(p) && !seen.has(p));
      if (!found || /node_modules/.test(found)) continue;
      try {
        queue.push({ file: found, text: readFileSync(found, "utf8"), name: found });
        inputs.push(found);
      } catch {
        // unreadable: nothing from it
      }
    }
  }
  if (!rules.length && !computed) return undefined;
  return { tool, file, dir, root: root ?? dir, rules, computed, inputs };
}

/**
 * Where a target points before captures are substituted: an absolute path, or a specifier to
 * resolve again (a package, or a Vite root-absolute `/src`).
 */
function materialize(
  target: ConfigPath,
  configDir: string,
  root: string,
): { abs?: string; spec?: string } {
  const p = target.path;
  if (p.startsWith("<rootDir>")) return { abs: join(root, p.slice("<rootDir>".length)) };
  if (target.base === "config") return { abs: isAbsolute(p) ? p : join(configDir, p) };
  if (p.startsWith("./") || p.startsWith("../") || p === "." || p === "..")
    return { abs: join(configDir, p) };
  if (isAbsolute(p) && !p.startsWith("/")) return { abs: p }; // C:\…
  // `/src` is root-absolute for Vite and a file-system path for the others: the resolver decides.
  return { spec: p };
}

export interface AliasHit {
  config: AliasConfig;
  rule: AliasRule;
  /** Candidates in order: absolute paths to probe, or specifiers to resolve again. */
  candidates: { abs?: string; spec?: string }[];
}

/** The first rule of `config` that maps `specifier`, with the paths it maps it to. */
export function matchAlias(config: AliasConfig, specifier: string): AliasHit | undefined {
  for (const rule of config.rules) {
    let apply: ((replacement: string) => string) | undefined;
    if (rule.regex) {
      let re: RegExp;
      try {
        re = new RegExp(rule.find);
      } catch {
        continue;
      }
      const m = re.exec(specifier);
      if (!m) continue;
      apply =
        config.tool === "jest"
          ? // Jest substitutes the captures into the whole target.
            (r) => r.replace(/\$(\d+)/g, (_, i) => m[Number(i)] ?? "")
          : config.tool === "babel"
            ? (r) => specifier.replace(re, r.replace(/\\(\d)/g, "$$$1"))
            : (r) => specifier.replace(re, r);
    } else {
      const f = rule.find;
      const hit =
        specifier === f ||
        (!rule.exact && f !== "" && specifier.startsWith(f.endsWith("/") ? f : `${f}/`));
      if (!hit) continue;
      apply = (r) => r + specifier.slice(f.length);
    }
    const candidates = rule.targets.map((t) => {
      // Captures go into the target as written: once joined into a path, a Windows separator
      // would swallow Babel's `\1` (`./src/\1` → `src\1`).
      if (rule.regex) return materialize({ ...t, path: apply(t.path) }, config.dir, config.root);
      const base = materialize(t, config.dir, config.root);
      return base.abs !== undefined ? { abs: apply(base.abs) } : { spec: apply(base.spec ?? "") };
    });
    return { config, rule, candidates };
  }
  return undefined;
}
