import { posix } from "node:path";

export interface ConfigIssue {
  path: string;
  message: string;
}

const MODES = ["fast", "balanced", "safe"];
const RISKS = ["low", "medium", "high", "critical"];
const CATEGORIES = ["unit", "integration", "e2e"];
const LAYOUTS = ["mirror", "colocated", "domain", "custom"];
const ADAPTERS = [
  "vitest",
  "jest",
  "node",
  "playwright",
  "cypress",
  "angular",
  "pytest",
  "unittest",
  "phpunit",
];
const FORMATS = ["html", "json", "junit", "markdown"];
const POLICIES = ["exclude", "test-source", "rebuild-required"];
const VISIBILITIES = ["public", "protected", "private"];
const MATCH_KEYS = [
  "path",
  "package",
  "class",
  "method",
  "function",
  "decorator",
  "visibility",
  "kind",
  "extends",
  "implements",
];

const TOP_KEYS: Record<string, string[] | null> = {
  include: null,
  exclude: null,
  mode: null,
  adapters: null,
  vcs: ["provider", "base", "snapshots"],
  snapshots: ["storeContent", "keep"],
  tests: ["layout", "directory", "naming", "match", "templates", "discovery"],
  generated: null,
  runners: null,
  triggers: null,
  rules: null,
  retries: null,
  adaptive: null,
  python: ["enabled", "interpreter"],
  php: ["enabled", "binary"],
  cache: null,
  hook: ["checks", "budgetMs", "runners", "exclude", "trailer"],
  parallelGroups: null,
  plugins: null,
  projects: null,
  timeoutMs: null,
  workers: null,
  reports: ["formats", "outputDir", "annotations"],
  storeDir: null,
};

/**
 * Why a configured path is not a safe project-relative path, or undefined when it is. The
 * configuration is repository content: it must not send SmartTest's writes (store, reports,
 * generated tests) or the runners' working directory outside the project (spec §30.2).
 * A command-line flag such as `--output` is the user's own choice and is not checked here.
 */
export function outsideProject(value: string): string | undefined {
  if (value.includes("\0")) return "must not contain NUL characters";
  const p = value.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p))
    return "must be a path relative to the project, not an absolute path";
  if (posix.normalize(p).split("/")[0] === "..") return "must stay inside the project (no ../)";
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Rules, at the top level or inside a project. */
function validateRules(
  rules: unknown,
  at: string,
  err: (path: string, message: string) => void,
): void {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    err(at, "must be an array");
    return;
  }
  const names = new Set<string>();
  for (const [i, rule] of rules.entries()) {
    const p = `${at}[${i}]`;
    if (!isObj(rule)) {
      err(p, "must be an object");
      continue;
    }
    if (typeof rule.name !== "string" || !rule.name) err(`${p}.name`, "is required");
    else if (names.has(rule.name)) err(`${p}.name`, `duplicate rule name "${rule.name}"`);
    else names.add(rule.name);
    if (!isObj(rule.match)) err(`${p}.match`, "is required and must be an object");
    else
      for (const [k, v] of Object.entries(rule.match)) {
        if (!MATCH_KEYS.includes(k))
          err(`${p}.match.${k}`, `unknown selector (expected one of ${MATCH_KEYS.join(", ")})`);
        else if (typeof v !== "string") err(`${p}.match.${k}`, "must be a string");
        else if (k === "visibility" && !VISIBILITIES.includes(v))
          err(`${p}.match.visibility`, `must be one of ${VISIBILITIES.join(", ")}`);
      }
    if (rule.risk !== undefined && !RISKS.includes(rule.risk as string))
      err(`${p}.risk`, `must be one of ${RISKS.join(", ")}`);
    if (
      rule.require !== undefined &&
      !(isStrArr(rule.require) && rule.require.every((r) => CATEGORIES.includes(r)))
    )
      err(`${p}.require`, `must be an array of: ${CATEGORIES.join(", ")}`);
    if (rule.execution !== undefined) {
      const e = rule.execution;
      if (!isObj(e)) err(`${p}.execution`, "must be an object");
      else {
        if (e.mode !== undefined && !MODES.includes(e.mode as string))
          err(`${p}.execution.mode`, `must be one of ${MODES.join(", ")}`);
        if (e.alwaysRunOnAffected !== undefined && typeof e.alwaysRunOnAffected !== "boolean")
          err(`${p}.execution.alwaysRunOnAffected`, "must be a boolean");
        if (e.retries !== undefined && !isCount(e.retries))
          err(`${p}.execution.retries`, "must be a non-negative integer");
      }
    }
    if (rule.coverage !== undefined) {
      if (!isObj(rule.coverage)) err(`${p}.coverage`, "must be an object");
      else
        for (const k of ["lines", "branches"]) {
          const v = rule.coverage[k];
          if (v !== undefined && !(typeof v === "number" && v >= 0 && v <= 100))
            err(`${p}.coverage.${k}`, "must be a number between 0 and 100");
        }
    }
    if (rule.generate !== undefined) {
      if (!isObj(rule.generate)) err(`${p}.generate`, "must be an object");
      else
        for (const k of ["template", "path"])
          if (rule.generate[k] !== undefined && typeof rule.generate[k] !== "string")
            err(`${p}.generate.${k}`, "must be a string");
    }
  }
}

/** Validates a raw configuration object. Errors block; warnings (unknown keys) don't. */
export function validateConfig(raw: unknown): { errors: ConfigIssue[]; warnings: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  if (!isObj(raw)) {
    err("", "configuration must export an object");
    return { errors, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") continue; // editor hint in smarttest.config.json
    if (!(key in TOP_KEYS)) {
      warnings.push({ path: key, message: "unknown option (ignored)" });
      continue;
    }
    const sub = TOP_KEYS[key];
    if (sub && isObj(value)) {
      for (const k of Object.keys(value))
        if (!sub.includes(k))
          warnings.push({ path: `${key}.${k}`, message: "unknown option (ignored)" });
    }
  }
  const c = raw;
  for (const k of ["include", "exclude", "triggers"])
    if (c[k] !== undefined && !isStrArr(c[k])) err(k, "must be an array of glob strings");
  if (c.plugins !== undefined && !(isStrArr(c.plugins) && c.plugins.every((p) => p.trim() !== "")))
    err(
      "plugins",
      "must be an array of module paths (relative to the project root) or package names",
    );
  else if (Array.isArray(c.plugins))
    for (const [i, p] of (c.plugins as string[]).entries()) {
      const why =
        p.startsWith(".") || p.startsWith("/") || /^[A-Za-z]:|^\\/.test(p)
          ? outsideProject(p)
          : undefined;
      if (why) err(`plugins[${i}]`, why);
    }
  if (c.mode !== undefined && !MODES.includes(c.mode as string))
    err("mode", `must be one of ${MODES.join(", ")}`);
  if (
    c.adapters !== undefined &&
    !(isStrArr(c.adapters) && c.adapters.every((a) => ADAPTERS.includes(a)))
  )
    err("adapters", `must be an array of: ${ADAPTERS.join(", ")}`);
  for (const k of ["retries", "timeoutMs", "workers"]) {
    const v = c[k];
    if (v !== undefined && !isCount(v)) err(k, "must be a non-negative integer");
  }
  if (c.adaptive !== undefined && typeof c.adaptive !== "boolean")
    err("adaptive", "must be a boolean");
  if (c.cache !== undefined && typeof c.cache !== "boolean") err("cache", "must be a boolean");
  if (c.python !== undefined) {
    const py = c.python as Record<string, unknown>;
    if (typeof py !== "object" || py === null || Array.isArray(py))
      err("python", "must be an object");
    else {
      if (py.enabled !== undefined && typeof py.enabled !== "boolean")
        err("python.enabled", "must be a boolean");
      if (py.interpreter !== undefined && (typeof py.interpreter !== "string" || !py.interpreter))
        err("python.interpreter", "must be a non-empty string");
    }
  }
  if (c.php !== undefined) {
    const php = c.php as Record<string, unknown>;
    if (typeof php !== "object" || php === null || Array.isArray(php))
      err("php", "must be an object");
    else {
      if (php.enabled !== undefined && typeof php.enabled !== "boolean")
        err("php.enabled", "must be a boolean");
      if (php.binary !== undefined && (typeof php.binary !== "string" || !php.binary))
        err("php.binary", "must be a non-empty string");
    }
  }
  if (
    c.parallelGroups !== undefined &&
    c.parallelGroups !== "auto" &&
    !(
      typeof c.parallelGroups === "number" &&
      Number.isInteger(c.parallelGroups) &&
      c.parallelGroups >= 1
    )
  )
    err("parallelGroups", 'must be a positive integer or "auto"');
  if (c.hook !== undefined) {
    if (!isObj(c.hook)) err("hook", "must be an object");
    else {
      const h = c.hook as Record<string, unknown>;
      if (h.budgetMs !== undefined && !(typeof h.budgetMs === "number" && h.budgetMs > 0))
        err("hook.budgetMs", "must be a positive number");
      if (h.runners !== undefined) {
        if (!(isStrArr(h.runners) && h.runners.every((a) => ADAPTERS.includes(a))))
          err("hook.runners", `must be an array of: ${ADAPTERS.join(", ")}`);
        else if (!h.runners.length)
          err(
            "hook.runners",
            "must name at least one runner (an empty list would run no test in the hook; remove the option to run every runner)",
          );
      }
      if (h.exclude !== undefined && !isStrArr(h.exclude))
        err("hook.exclude", "must be an array of glob strings");
      if (h.trailer !== undefined && typeof h.trailer !== "boolean")
        err("hook.trailer", "must be true or false");
      if (h.checks !== undefined) {
        if (!Array.isArray(h.checks)) err("hook.checks", "must be an array");
        else
          h.checks.forEach((k, i) => {
            if (!isObj(k) || typeof k.name !== "string" || typeof k.run !== "string")
              err(
                `hook.checks[${i}]`,
                "must be { name: string, run: string, projects?, files?, stage? }",
              );
            else {
              if (!k.name.trim()) err(`hook.checks[${i}].name`, "must not be empty");
              if (!k.run.trim()) err(`hook.checks[${i}].run`, "must not be empty");
              if (
                k.projects !== undefined &&
                (!Array.isArray(k.projects) || k.projects.some((p) => typeof p !== "string"))
              )
                err(`hook.checks[${i}].projects`, "must be an array of project directories");
              if (k.files !== undefined && typeof k.files !== "string")
                err(`hook.checks[${i}].files`, "must be a glob string");
              if (
                k.stage !== undefined &&
                !["pre-commit", "pre-push", "both"].includes(k.stage as string)
              )
                err(`hook.checks[${i}].stage`, "must be pre-commit, pre-push or both");
            }
          });
      }
    }
  }
  if (c.projects !== undefined) {
    if (!isObj(c.projects)) err("projects", "must be an object keyed by directory");
    else
      for (const [dir, p] of Object.entries(c.projects)) {
        if (!isObj(p)) {
          err(`projects.${dir}`, "must be an object");
          continue;
        }
        for (const k of Object.keys(p))
          if (!["tests", "mode", "rules"].includes(k))
            warn(`projects.${dir}.${k}`, "unknown key (ignored)");
        if (p.mode !== undefined && !MODES.includes(p.mode as string))
          err(`projects.${dir}.mode`, `must be one of: ${MODES.join(", ")}`);
        if (p.tests !== undefined) {
          if (!isObj(p.tests)) err(`projects.${dir}.tests`, "must be an object");
          else {
            if (p.tests.layout !== undefined && !LAYOUTS.includes(p.tests.layout as string))
              err(`projects.${dir}.tests.layout`, `must be one of ${LAYOUTS.join(", ")}`);
            for (const k of ["directory", "naming", "path", "templates"])
              if (p.tests[k] !== undefined && typeof p.tests[k] !== "string")
                err(`projects.${dir}.tests.${k}`, "must be a string");
          }
        }
        validateRules(p.rules, `projects.${dir}.rules`, err);
      }
  }
  if (c.storeDir !== undefined && typeof c.storeDir !== "string")
    err("storeDir", "must be a string");
  else if (typeof c.storeDir === "string") {
    const why = outsideProject(c.storeDir);
    if (why) err("storeDir", why);
    else if (posix.normalize(c.storeDir.replace(/\\/g, "/")).replace(/\/+$/, "") === ".")
      err("storeDir", "must be a subdirectory, not the project root (uninstall removes it)");
  }
  if (c.vcs !== undefined) {
    if (!isObj(c.vcs)) err("vcs", "must be an object");
    else {
      if (
        c.vcs.provider !== undefined &&
        !["auto", "git", "svn", "hg", "native"].includes(c.vcs.provider as string)
      )
        err("vcs.provider", "must be auto, git, svn, hg or native");
      if (c.vcs.base !== undefined && typeof c.vcs.base !== "string")
        err("vcs.base", "must be a string");
      if (c.vcs.snapshots !== undefined && typeof c.vcs.snapshots !== "boolean")
        err("vcs.snapshots", "must be a boolean");
    }
  }
  if (c.tests !== undefined) {
    if (!isObj(c.tests)) err("tests", "must be an object");
    else {
      if (c.tests.layout !== undefined && !LAYOUTS.includes(c.tests.layout as string))
        err("tests.layout", `must be one of ${LAYOUTS.join(", ")}`);
      if (c.tests.match !== undefined && !isStrArr(c.tests.match))
        err("tests.match", "must be an array of globs");
      for (const k of ["directory", "naming", "templates"])
        if (c.tests[k] !== undefined && typeof c.tests[k] !== "string")
          err(`tests.${k}`, "must be a string");
      for (const k of ["directory", "templates"]) {
        const why = typeof c.tests[k] === "string" ? outsideProject(c.tests[k] as string) : "";
        if (why) err(`tests.${k}`, why);
      }
    }
  }
  if (
    isObj(c.tests) &&
    c.tests.discovery !== undefined &&
    !["runner", "static"].includes(c.tests.discovery as string)
  ) {
    err("tests.discovery", "must be runner or static");
  }
  if (c.runners !== undefined) {
    if (!Array.isArray(c.runners)) err("runners", "must be an array");
    else
      for (const [i, r] of c.runners.entries()) {
        const p = `runners[${i}]`;
        if (!isObj(r)) {
          err(p, "must be an object");
          continue;
        }
        if (!ADAPTERS.includes(r.adapter as string))
          err(`${p}.adapter`, `must be one of ${ADAPTERS.join(", ")}`);
        if (r.project !== undefined && typeof r.project !== "string")
          err(`${p}.project`, "must be a string");
        for (const k of ["dir", "config"]) {
          if (r[k] !== undefined && typeof r[k] !== "string") err(`${p}.${k}`, "must be a string");
          const why = typeof r[k] === "string" ? outsideProject(r[k] as string) : undefined;
          if (why) err(`${p}.${k}`, why);
        }
        if (r.patterns !== undefined && !isStrArr(r.patterns))
          err(`${p}.patterns`, "must be an array of globs");
      }
  }
  if (c.reports !== undefined) {
    if (!isObj(c.reports)) err("reports", "must be an object");
    else {
      if (
        c.reports.formats !== undefined &&
        !(isStrArr(c.reports.formats) && c.reports.formats.every((f) => FORMATS.includes(f)))
      )
        err("reports.formats", `must be an array of: ${FORMATS.join(", ")}`);
      if (c.reports.outputDir !== undefined) {
        const why =
          typeof c.reports.outputDir === "string"
            ? outsideProject(c.reports.outputDir)
            : "must be a string";
        if (why) err("reports.outputDir", why);
      }
      if (c.reports.annotations !== undefined && typeof c.reports.annotations !== "boolean")
        err("reports.annotations", "must be a boolean");
    }
  }
  if (c.snapshots !== undefined) {
    if (!isObj(c.snapshots)) err("snapshots", "must be an object");
    else {
      if (c.snapshots.storeContent !== undefined && typeof c.snapshots.storeContent !== "boolean")
        err("snapshots.storeContent", "must be a boolean");
      if (c.snapshots.keep !== undefined && !isCount(c.snapshots.keep))
        err("snapshots.keep", "must be a non-negative integer");
    }
  }
  if (c.generated !== undefined) {
    if (!Array.isArray(c.generated)) err("generated", "must be an array");
    else
      c.generated.forEach((g, i) => {
        if (!isObj(g) || typeof g.path !== "string" || !POLICIES.includes(g.policy as string))
          err(`generated[${i}]`, `must be { path: string, policy: ${POLICIES.join(" | ")} }`);
        else if (
          g.from !== undefined &&
          (!Array.isArray(g.from) || g.from.some((f) => typeof f !== "string"))
        )
          err(`generated[${i}].from`, "must be an array of globs");
      });
  }
  validateRules(c.rules, "rules", err);
  return { errors, warnings };
}
