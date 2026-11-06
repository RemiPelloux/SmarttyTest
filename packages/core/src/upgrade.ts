/**
 * The upgrade assistant behind `smarttest sync`: what a newer SmartTest offers a configuration and
 * a hook written by an older one, each proposal a diff the user accepts or not. Nothing here
 * writes; `SmartTest.applyUpgrades` writes only the accepted proposals, atomically, and only when
 * the file is still what the proposal was computed from.
 *
 * Configuration edits are text edits of the config file (TypeScript/JavaScript object literal or
 * JSON) that touch only the key they change, so comments and hand formatting elsewhere stay. An
 * edit that cannot be placed safely becomes a manual step, never a guess.
 */
import {
  BUILTIN_TRIGGERS,
  DEFAULT_INCLUDE,
  type SmartTestConfig,
  validateConfig,
} from "@smarttest/config";
import type { FilePlan } from "@smarttest/smart-init";

export type UpgradeId =
  | "redundant-triggers"
  | "language-include"
  | "hook-scope"
  | "hook-trailer"
  | "hook-block";

export interface UpgradeProposal {
  id: UpgradeId;
  /** Stable key of this proposal (`hook-block:pre-push`), used to accept it. */
  key: string;
  title: string;
  reason: string;
  /** The change, previewed as a diff. Absent: a step to do by hand (`manual`). */
  plan?: FilePlan;
  /** What to do by hand when the change cannot be written safely. */
  manual?: string;
  /** Hook proposals: the stage, re-planned at apply time. */
  stage?: "pre-commit" | "pre-push";
}

/** A config edit: the new text, or undefined when it cannot be placed safely. */
export type ConfigEdit = (text: string) => string | undefined;

// ── text edits of a config file ─────────────────────────────────────────────────────────────

const isJson = (text: string) => /^\s*\{/.test(text);

/** The quote character the file uses most for strings. */
function quoteOf(text: string): "'" | '"' {
  const single = (text.match(/'/g) ?? []).length;
  const double = (text.match(/"/g) ?? []).length;
  return single > double ? "'" : '"';
}

const literal = (s: string, q: "'" | '"') =>
  q === '"' ? JSON.stringify(s) : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const arrayLiteral = (items: readonly string[], q: "'" | '"') =>
  `[${items.map((i) => literal(i, q)).join(", ")}]`;

/** The single `key: [ … ]` of string literals at the top of the config, with its items. */
function findArray(
  text: string,
  key: string,
): { start: number; end: number; items: string[] } | undefined {
  const re = new RegExp(`(^|[\\s{,])${key}\\s*:\\s*\\[([^\\]]*)\\]`, "g");
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) return undefined;
  const m = hits[0] as RegExpMatchArray;
  const body = m[2] ?? "";
  const items: string[] = [];
  const stripped = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  for (const it of stripped.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g))
    items.push((it[1] ?? it[2] ?? "").replace(/\\(.)/g, "$1"));
  // Anything but string literals (a spread, a variable): not ours to rewrite.
  if (stripped.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\s,]/g, "") !== "") return undefined;
  const start = (m.index ?? 0) + (m[1] ?? "").length;
  return { start, end: (m.index ?? 0) + m[0].length, items };
}

/** Replaces a top-level string array (`triggers`, `include`) or drops the key when it is empty. */
export function setArray(key: string, items: readonly string[]): ConfigEdit {
  return (text) => {
    if (isJson(text)) {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (items.length) obj[key] = [...items];
      else delete obj[key];
      return `${JSON.stringify(obj, null, /^\{\n(\s+)/.exec(text)?.[1] ?? "  ")}\n`;
    }
    const found = findArray(text, key);
    if (!found) return undefined;
    if (items.length)
      return `${text.slice(0, found.start)}${key}: ${arrayLiteral(items, quoteOf(text))}${text.slice(found.end)}`;
    // Drop `key: [...]` with its trailing comma and, when alone on it, the line.
    const lineStart = text.lastIndexOf("\n", found.start - 1) + 1;
    const after = /^\s*,?[ \t]*(?:\/\/[^\n]*)?\n?/.exec(text.slice(found.end))?.[0] ?? "";
    const alone = text.slice(lineStart, found.start).trim() === "" && after.endsWith("\n");
    return alone
      ? `${text.slice(0, lineStart)}${text.slice(found.end + after.length)}`
      : `${text.slice(0, found.start)}${text.slice(found.end).replace(/^\s*,\s*/, "")}`;
  };
}

/** Sets `hook.<key>` to a value (a JS literal), adding the `hook` object when there is none. */
export function setHookKey(key: string, value: (q: "'" | '"') => string): ConfigEdit {
  return (text) => {
    const q = quoteOf(text);
    if (isJson(text)) {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const hook = (obj.hook ?? {}) as Record<string, unknown>;
      hook[key] = JSON.parse(value('"'));
      obj.hook = hook;
      return `${JSON.stringify(obj, null, /^\{\n(\s+)/.exec(text)?.[1] ?? "  ")}\n`;
    }
    const hooks = [...text.matchAll(/(^|[\s{,])hook\s*:\s*\{/g)];
    if (hooks.length > 1) return undefined;
    if (hooks.length === 1) {
      const m = hooks[0] as RegExpMatchArray;
      const open = (m.index ?? 0) + m[0].length;
      // Already set (by hand, perhaps to something else): left to the user.
      const close = text.indexOf("}", open);
      if (new RegExp(`\\b${key}\\s*:`).test(text.slice(open, close < 0 ? undefined : close)))
        return undefined;
      const inline = text[open] !== "\n";
      return inline
        ? `${text.slice(0, open)} ${key}: ${value(q)},${text.slice(open)}`
        : `${text.slice(0, open)}\n    ${key}: ${value(q)},${text.slice(open)}`;
    }
    // No hook object: a new property before the object's closing brace (`});` or `};`).
    const end = /\n([ \t]*)\}\s*\)?\s*;?\s*$/.exec(text);
    if (!end) return undefined;
    const before = text.slice(0, end.index).replace(/\s*$/, "");
    const indent = /\n([ \t]+)\w/.exec(text)?.[1] ?? "  ";
    const comma = before.endsWith(",") || before.endsWith("{") ? "" : ",";
    return `${before}${comma}\n${indent}hook: { ${key}: ${value(q)} },${text.slice(end.index)}`;
  };
}

/** True when this SmartTest's configuration schema knows `hook.<key>` (a later feature). */
export function knowsHookKey(key: string, sample: unknown): boolean {
  const { errors, warnings } = validateConfig({ hook: { [key]: sample } });
  return !errors.length && !warnings.length;
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────

export interface UpgradeFacts {
  raw: SmartTestConfig;
  /** Project files (Git listing, or walked). */
  files: readonly string[];
  /** Browser runners to keep out of the hook (`hook.runners`), when SmartTest would suggest one. */
  hookScope?: string[];
  /** Files that build a commit trailer of the project's own (script, commit-msg hook). */
  trailerEvidence: string[];
}

export interface ConfigUpgrade {
  id: UpgradeId;
  key: string;
  title: string;
  reason: string;
  edit: ConfigEdit;
}

const LANG_LABEL: Record<string, string> = { py: "Python", php: "PHP" };

/** The configuration proposals for these facts (each as an edit of the config text). */
export function configUpgrades(facts: UpgradeFacts): ConfigUpgrade[] {
  const out: ConfigUpgrade[] = [];
  const { raw } = facts;
  // Triggers the user listed that are built in: since 1.1 a lockfile or manifest change selects
  // by package, whatever the config lists, and built-in triggers can never be removed.
  const builtin = new Set(BUILTIN_TRIGGERS);
  const redundant = (raw.triggers ?? []).filter((t) => builtin.has(t));
  if (redundant.length)
    out.push({
      id: "redundant-triggers",
      key: "redundant-triggers",
      title: "Remove triggers that are built in",
      reason: `${redundant.join(", ")} ${redundant.length === 1 ? "is" : "are"} built-in trigger${redundant.length === 1 ? "" : "s"}${redundant.some((t) => /lock|package\.json/.test(t)) ? "; lockfile and package.json changes select by package since 1.1, so listing them changes nothing" : ""}. Removing ${redundant.length === 1 ? "it" : "them"} changes no selection.`,
      edit: setArray(
        "triggers",
        (raw.triggers ?? []).filter((t) => !builtin.has(t)),
      ),
    });
  // A hand-written `include` predating a language SmartTest now analyses.
  if (raw.include?.length) {
    const missing = DEFAULT_INCLUDE.filter((g) => {
      const ext = /\*\.(\w+)$/.exec(g)?.[1];
      return (
        ext &&
        LANG_LABEL[ext] &&
        !raw.include?.some((i) => i.endsWith(`.${ext}`) || i.includes(`,${ext}`)) &&
        facts.files.some(
          (f) => f.endsWith(`.${ext}`) && !/(?:^|\/)(?:node_modules|vendor|\.venv|venv)\//.test(f),
        )
      );
    });
    if (missing.length) {
      const langs = missing.map((g) => LANG_LABEL[/\*\.(\w+)$/.exec(g)?.[1] ?? ""]).join(" and ");
      out.push({
        id: "language-include",
        key: "language-include",
        title: `Analyse the ${langs} files`,
        reason: `the project has ${langs} files and SmartTest analyses them now, but \`include\` lists only other files, so their tests are never selected by a change to them. Add ${missing.join(", ")} (or set \`${missing.some((g) => g.endsWith(".py")) ? "python" : "php"}: { enabled: false }\` to keep them out deliberately).`,
        edit: setArray("include", [...(raw.include ?? []), ...missing]),
      });
    }
  }
  // Browser specs (end-to-end, often against a deployed environment) run by the commit hook.
  if (facts.hookScope?.length && !raw.hook?.runners)
    out.push({
      id: "hook-scope",
      key: "hook-scope",
      title: "Keep browser specs out of the commit hook",
      reason: `Playwright or Cypress specs sit next to ${facts.hookScope.join(", ")}: the hook would run them on every commit, against whatever environment they target. With \`hook.runners\`, the hook runs ${facts.hookScope.join(", ")} and reports the browser specs it selects as left to CI (never as passed); \`run\` and \`ci\` still run them.`,
      edit: setHookKey("runners", (q) => arrayLiteral(facts.hookScope ?? [], q)),
    });
  // The project builds its own commit trailer (openpro-backend's `test-trailer.sh`).
  if (
    facts.trailerEvidence.length &&
    (raw.hook as Record<string, unknown> | undefined)?.trailer === undefined &&
    knowsHookKey("trailer", true)
  )
    out.push({
      id: "hook-trailer",
      key: "hook-trailer",
      title: "Let SmartTest write the commit trailer",
      reason: `${facts.trailerEvidence.join(", ")} add${facts.trailerEvidence.length === 1 ? "s" : ""} a test trailer to commit messages. \`hook.trailer\` makes SmartTest write it from the pre-commit run, and never on a commit whose tests did not run; \`smarttest hook install\` then adds the commit-msg step, and the script can be removed.`,
      edit: setHookKey("trailer", () => "true"),
    });
  return out;
}

/** A trailer of the project's own: a script named like one, or a commit-msg hook calling it. */
export function trailerEvidence(
  files: readonly string[],
  read: (file: string) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const f of files)
    if (
      /(?:^|\/)[\w.-]*trailer[\w.-]*\.(?:sh|mjs|cjs|js|ts|php|py)$/i.test(f) &&
      !/node_modules\//.test(f)
    )
      out.add(f);
  for (const f of [
    ".husky/commit-msg",
    "lefthook.yml",
    "captainhook.json",
    ".githooks/commit-msg",
  ]) {
    const text = read(f);
    if (text && /trailer|^Tests:|\bTests: /m.test(text) && !/smarttest/i.test(text)) out.add(f);
  }
  return [...out].sort();
}
