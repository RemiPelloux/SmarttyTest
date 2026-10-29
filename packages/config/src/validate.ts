export interface ConfigIssue {
  path: string;
  message: string;
}

const MODES = ["fast", "balanced", "safe"];
const RISKS = ["low", "medium", "high", "critical"];
const CATEGORIES = ["unit", "integration", "e2e"];
const LAYOUTS = ["mirror", "colocated", "domain", "custom"];
const ADAPTERS = ["vitest", "jest", "node"];
const FORMATS = ["html", "json", "junit", "markdown"];
const POLICIES = ["exclude", "test-source", "rebuild-required"];
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
  projects: null,
  timeoutMs: null,
  workers: null,
  reports: ["formats", "outputDir"],
  storeDir: null,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

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
  if (c.mode !== undefined && !MODES.includes(c.mode as string))
    err("mode", `must be one of ${MODES.join(", ")}`);
  if (
    c.adapters !== undefined &&
    !(isStrArr(c.adapters) && c.adapters.every((a) => ADAPTERS.includes(a)))
  )
    err("adapters", `must be an array of: ${ADAPTERS.join(", ")}`);
  for (const k of ["retries", "timeoutMs", "workers"]) {
    const v = c[k];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 0))
      err(k, "must be a non-negative integer");
  }
  if (c.adaptive !== undefined && typeof c.adaptive !== "boolean")
    err("adaptive", "must be a boolean");
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
        if (p.tests !== undefined && !isObj(p.tests))
          err(`projects.${dir}.tests`, "must be an object");
        if (p.rules !== undefined && !Array.isArray(p.rules))
          err(`projects.${dir}.rules`, "must be an array");
      }
  }
  if (c.storeDir !== undefined && typeof c.storeDir !== "string")
    err("storeDir", "must be a string");
  if (c.vcs !== undefined) {
    if (!isObj(c.vcs)) err("vcs", "must be an object");
    else {
      if (
        c.vcs.provider !== undefined &&
        !["auto", "git", "native"].includes(c.vcs.provider as string)
      )
        err("vcs.provider", "must be auto, git or native");
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
        for (const k of ["dir", "config"])
          if (r[k] !== undefined && typeof r[k] !== "string") err(`${p}.${k}`, "must be a string");
        if (r.patterns !== undefined && !isStrArr(r.patterns))
          err(`${p}.patterns`, "must be an array of globs");
      }
  }
  if (c.reports !== undefined) {
    if (!isObj(c.reports)) err("reports", "must be an object");
    else if (
      c.reports.formats !== undefined &&
      !(isStrArr(c.reports.formats) && c.reports.formats.every((f) => FORMATS.includes(f)))
    )
      err("reports.formats", `must be an array of: ${FORMATS.join(", ")}`);
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
  if (c.rules !== undefined) {
    if (!Array.isArray(c.rules)) err("rules", "must be an array");
    else {
      const names = new Set<string>();
      for (const [i, rule] of c.rules.entries()) {
        const p = `rules[${i}]`;
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
          }
        if (rule.risk !== undefined && !RISKS.includes(rule.risk as string))
          err(`${p}.risk`, `must be one of ${RISKS.join(", ")}`);
        if (
          rule.require !== undefined &&
          !(isStrArr(rule.require) && rule.require.every((r) => CATEGORIES.includes(r)))
        )
          err(`${p}.require`, `must be an array of: ${CATEGORIES.join(", ")}`);
        if (rule.execution !== undefined) {
          if (!isObj(rule.execution)) err(`${p}.execution`, "must be an object");
          else if (
            rule.execution.mode !== undefined &&
            !MODES.includes(rule.execution.mode as string)
          )
            err(`${p}.execution.mode`, `must be one of ${MODES.join(", ")}`);
        }
        if (rule.coverage !== undefined && isObj(rule.coverage)) {
          for (const k of ["lines", "branches"]) {
            const v = rule.coverage[k];
            if (v !== undefined && !(typeof v === "number" && v >= 0 && v <= 100))
              err(`${p}.coverage.${k}`, "must be a number between 0 and 100");
          }
        }
      }
    }
  }
  return { errors, warnings };
}
