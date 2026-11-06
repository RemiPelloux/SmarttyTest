/**
 * The commit trailer step (`hook.trailer`): a `commit-msg` step that runs
 * `smarttest hook trailer <message file>`, which adds `Tests: …` from the pre-commit run of the
 * committed tree. Written into the hook setup the pre-commit step uses (husky, lefthook,
 * simple-git-hooks, CaptainHook or plain .git/hooks) and removed by `hook uninstall`. The step
 * never blocks a commit: SmartTest missing, or no record for the tree, adds nothing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, readText } from "@smarttest/shared";
import {
  detectHookTarget,
  type HookManager,
  indentOf,
  projectPrefix,
  SHELL_SHEBANG,
  shellQuote,
} from "./hooks.js";
import type { FilePlan } from "./index.js";

/** Where the trailer step can go: the hook managers, and CaptainHook (`captainhook.json`). */
export type TrailerManager = HookManager | "captainhook";

export const TRAILER_COMMAND = "npx --no-install smarttest hook trailer";
const START = "# >>> smarttest trailer >>>";
const END = "# <<< smarttest trailer <<<";
const LEFTHOOK_ENTRY = "smarttest-trailer: # smarttest";
const CAPTAINHOOK_FILE = "captainhook.json";
/** SmartTest's trailer step, however it was written (a command, an action, a package value). */
const OWN = /smarttest(?:@[\w.-]+)?\s+hook\s+trailer\b/;
/** SmartTest's pre-commit step in captainhook.json (written by `hook install` or by hand). */
const OWN_RUN = /smarttest(?:@[\w.-]+)?\s+run\b/;

export interface TrailerPlan {
  manager: TrailerManager;
  /** The file that holds the `commit-msg` step. */
  file: string;
  installed: boolean;
  plan: FilePlan;
  notes: string[];
}

/** The shell block of a husky or plain Git `commit-msg` hook. */
function block(prefix: string): string {
  const bin = prefix ? `${prefix}/node_modules/.bin/smarttest` : "node_modules/.bin/smarttest";
  // Git passes the message file relative to the top-level; `hook trailer` resolves it from there
  // when the project is in a subdirectory.
  const run = prefix
    ? `(cd ${shellQuote(prefix)} && ${TRAILER_COMMAND} "$1") || true`
    : `${TRAILER_COMMAND} "$1" || true`;
  return [
    START,
    "# Adds a Tests: trailer from the pre-commit run of this exact content (https://github.com/RemiPelloux/SmarttyTest).",
    `if [ -x ${shellQuote(bin)} ]; then`,
    `  ${run}`,
    "fi",
    END,
  ].join("\n");
}

/** The block before a final `exit` (it would never run after it), else at the end. */
function insertBlock(text: string | undefined, fresh: string): string {
  const lines = (text ?? "#!/bin/sh\n").replace(/\n*$/, "").split("\n");
  let at = lines.length;
  while (at > 0 && !(lines[at - 1] ?? "").trim()) at--;
  if (at > 0 && /^\s*exit\b/.test(lines[at - 1] ?? "")) at--;
  lines.splice(at, 0, fresh);
  return `${lines.join("\n")}\n`;
}

function removeBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === END);
  if (start < 0 || end < 0) return text;
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

const shellInstalled = (text: string | undefined) =>
  !!text &&
  text.split("\n").some((l) => l.trim() === START || (!l.trim().startsWith("#") && OWN.test(l)));

// ── lefthook ───────────────────────────────────────────────────────────────────────────────

function lefthookSection(lines: readonly string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => /^commit-msg:\s*(#.*)?$/.test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? "") || !(lines[end] ?? "").trim())) end++;
  return { start, end };
}

function installLefthook(text: string | undefined): string {
  // lefthook passes Git's arguments as {1}, {2}…: {1} is the message file.
  const entry = (indent: string) => [
    `${indent}${LEFTHOOK_ENTRY}`,
    `${indent}  run: ${TRAILER_COMMAND} {1} || true`,
  ];
  const lines = (text ?? "").split("\n");
  const section = lefthookSection(lines);
  if (!section) {
    const base = (text ?? "").replace(/\s*$/, "");
    return `${base ? `${base}\n\n` : ""}${["commit-msg:", "  commands:", ...entry("    ")].join("\n")}\n`;
  }
  const cmd = lines
    .slice(section.start + 1, section.end)
    .findIndex((l) => /^\s+commands:\s*(#.*)?$/.test(l));
  if (cmd === -1) {
    lines.splice(section.start + 1, 0, "  commands:", ...entry("    "));
  } else {
    const at = section.start + 1 + cmd;
    const indent = (lines[at] ?? "").match(/^\s*/)?.[0] ?? "  ";
    const child = (lines[at + 1] ?? "").match(/^\s*/)?.[0] ?? `${indent}  `;
    lines.splice(at + 1, 0, ...entry(child.length > indent.length ? child : `${indent}  `));
  }
  return lines.join("\n");
}

function uninstallLefthook(text: string): string {
  const lines = text.split("\n");
  const section = lefthookSection(lines);
  if (!section) return text;
  const at = lines.findIndex(
    (l, i) => i > section.start && i < section.end && l.trim() === LEFTHOOK_ENTRY,
  );
  if (at < 0) return text;
  let n = 1;
  const indent = indentOf(lines[at] ?? "");
  while ((lines[at + n] ?? "").trim() && indentOf(lines[at + n] ?? "") > indent) n++;
  lines.splice(at, n);
  // A section left with nothing but `commands:` was SmartTest's own: removed whole.
  const left = lefthookSection(lines);
  if (left) {
    const body = lines.slice(left.start + 1, left.end).filter((l) => l.trim());
    if (body.every((l) => /^\s+commands:\s*$/.test(l))) {
      lines.splice(left.start, left.end - left.start);
      return `${lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s*$/, "")}\n`;
    }
  }
  return lines.join("\n");
}

// ── simple-git-hooks ───────────────────────────────────────────────────────────────────────

const simpleStep = (prefix: string) =>
  prefix
    ? `((cd ${shellQuote(prefix)} && ${TRAILER_COMMAND} "$1") || true)`
    : `(${TRAILER_COMMAND} "$1" || true)`;

/** SmartTest's step in a simple-git-hooks value, with the ` && ` that joins it. */
const SIMPLE_OWN =
  /(?:\s*&&\s*)?\(\(?(?:cd '(?:[^']|'\\'')*' && )?npx --no-install smarttest hook trailer "\$1"\)? \|\| true\)/;

function simpleWithout(value: string): string | undefined {
  return value.replace(SIMPLE_OWN, "").trim() || undefined;
}

// ── CaptainHook ────────────────────────────────────────────────────────────────────────────

interface CaptainAction {
  action?: unknown;
  [key: string]: unknown;
}

/** The trailer action: the project's SmartTest when installed with npm, else the published one. */
async function captainHookCommand(root: string): Promise<string> {
  const pkg = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  const local =
    existsSync(join(root, "node_modules", ".bin", "smarttest")) ||
    !!pkg?.devDependencies?.["@tkmremi/smarttest"] ||
    !!pkg?.dependencies?.["@tkmremi/smarttest"];
  const cli = local ? "npx --no-install smarttest" : "npx --yes @tkmremi/smarttest";
  // {$FILE} is CaptainHook's placeholder for the message file; a failure never blocks a commit.
  return `${cli} hook trailer {$FILE} || true`;
}

const captainActions = (json: Record<string, unknown>, stage: string): CaptainAction[] => {
  const actions = (json[stage] as { actions?: unknown } | undefined)?.actions;
  return Array.isArray(actions) ? (actions as CaptainAction[]) : [];
};

/** captainhook.json, when SmartTest runs from it (or CaptainHook was asked for). */
async function captainHook(
  root: string,
  prefer?: TrailerManager,
): Promise<{ text: string; json: Record<string, unknown> } | undefined> {
  if (prefer && prefer !== "captainhook") return undefined;
  const text = await readText(join(root, CAPTAINHOOK_FILE));
  if (text === undefined) return undefined;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
    const runs = ["pre-commit", "pre-push"].some((s) =>
      captainActions(json, s).some((a) => typeof a.action === "string" && OWN_RUN.test(a.action)),
    );
    return prefer === "captainhook" || runs ? { text, json } : undefined;
  } catch {
    return undefined;
  }
}

const jsonIndent = (text: string, fallback: string) => /^\{\n(\s+)/.exec(text)?.[1] ?? fallback;

// ── plans ──────────────────────────────────────────────────────────────────────────────────

/**
 * Plans the `commit-msg` step in the hook setup SmartTest's pre-commit step uses (`prefer`, else
 * detected as for the pre-commit hook). `pending` holds files another plan of the same install
 * already changes (simple-git-hooks and lefthook keep every hook in one file): the step is added
 * to that version.
 */
export async function planTrailerInstall(
  root: string,
  options: { manager?: TrailerManager; pending?: ReadonlyMap<string, string> } = {},
): Promise<TrailerPlan> {
  const read = async (file: string) => options.pending?.get(file) ?? readText(join(root, file));
  const skip = (file: string, reason: string): FilePlan => ({
    path: file,
    action: "skip",
    reason,
    risk: "medium",
  });
  const captain = await captainHook(root, options.manager);
  if (captain) {
    const current = (await read(CAPTAINHOOK_FILE)) ?? captain.text;
    const json = JSON.parse(current) as Record<string, unknown>;
    const actions = captainActions(json, "commit-msg");
    const installed = actions.some((a) => typeof a.action === "string" && OWN.test(a.action));
    if (installed)
      return {
        manager: "captainhook",
        file: CAPTAINHOOK_FILE,
        installed,
        notes: [],
        plan: skip(CAPTAINHOOK_FILE, "the commit trailer step is already in CaptainHook"),
      };
    const section = (json["commit-msg"] ?? {}) as Record<string, unknown>;
    json["commit-msg"] = {
      ...section,
      enabled: section.enabled ?? true,
      actions: [...actions, { action: await captainHookCommand(root) }],
    };
    return {
      manager: "captainhook",
      file: CAPTAINHOOK_FILE,
      installed,
      notes: [],
      plan: {
        path: CAPTAINHOOK_FILE,
        action: "modify",
        reason: "add the Tests: trailer to commit messages (CaptainHook commit-msg)",
        before: current,
        after: `${JSON.stringify(json, null, jsonIndent(current, "    "))}\n`,
        risk: "medium",
      },
    };
  }
  const manager = options.manager === "captainhook" ? undefined : options.manager;
  const target = await detectHookTarget(root, manager, "commit-msg");
  const notes: string[] = [];
  const base = { manager: target.manager as TrailerManager, file: target.file, notes };
  if (target.outside || target.dependency)
    return {
      ...base,
      installed: false,
      plan: skip(
        target.file,
        `core.hooksPath points ${target.outside ? "outside the repository" : "into an installed dependency"}; add \`${TRAILER_COMMAND} "$1"\` to its commit-msg hook yourself`,
      ),
    };
  const current = await read(target.file);
  const prefix = target.manager === "lefthook" ? "" : projectPrefix(root);
  if (target.manager === "simple-git-hooks") {
    const pkg = JSON.parse(current ?? "{}") as Record<string, unknown>;
    const hooks = (pkg["simple-git-hooks"] as Record<string, string> | undefined) ?? {};
    const existing = hooks["commit-msg"];
    if (existing && OWN.test(existing))
      return {
        ...base,
        installed: true,
        plan: skip(target.file, "the commit trailer step is already in simple-git-hooks"),
      };
    hooks["commit-msg"] = existing ? `${existing} && ${simpleStep(prefix)}` : simpleStep(prefix);
    pkg["simple-git-hooks"] = hooks;
    notes.push("run `npx simple-git-hooks` once to update .git/hooks");
    return {
      ...base,
      installed: false,
      plan: {
        path: target.file,
        action: "modify",
        reason: "add the Tests: trailer to commit messages (simple-git-hooks commit-msg)",
        ...(current !== undefined ? { before: current } : {}),
        after: `${JSON.stringify(pkg, null, jsonIndent(current ?? "", "  "))}\n`,
        risk: "medium",
      },
    };
  }
  if (target.manager === "lefthook") {
    const section = current ? lefthookSection(current.split("\n")) : undefined;
    const lines = current?.split("\n") ?? [];
    if (section && lines.slice(section.start, section.end).some((l) => OWN.test(l)))
      return {
        ...base,
        installed: true,
        plan: skip(target.file, "the commit trailer step is already in lefthook"),
      };
    if (projectPrefix(root))
      notes.push(
        "lefthook reads its configuration at the top-level of the repository; this project is in a subdirectory, so add the smarttest-trailer command to the top-level lefthook.yml with `root:` set to this directory",
      );
    return {
      ...base,
      installed: false,
      plan: {
        path: target.file,
        action: current === undefined ? "create" : "modify",
        reason: "add the Tests: trailer to commit messages (lefthook commit-msg)",
        ...(current !== undefined ? { before: current } : {}),
        after: installLefthook(current),
        risk: "medium",
      },
    };
  }
  // husky or a plain Git hook: a shell script.
  if (shellInstalled(current))
    return {
      ...base,
      installed: true,
      plan: skip(target.file, "the commit trailer step is already in this hook"),
    };
  const shebang = current?.split("\n", 1)[0] ?? "";
  if (shebang.startsWith("#!") && !SHELL_SHEBANG.test(shebang))
    return {
      ...base,
      installed: false,
      plan: skip(
        target.file,
        `${target.file} is not a shell script (${shebang}); call \`${TRAILER_COMMAND} <message file>\` from it yourself`,
      ),
    };
  if (target.copiedBy)
    notes.push(
      `${target.file} is copied into .git/hooks by ${target.copiedBy.by} (\`${target.copiedBy.command}\`): run it again so the installed hook gets the change`,
    );
  return {
    ...base,
    installed: false,
    plan: {
      path: target.file,
      action: current === undefined ? "create" : "modify",
      reason: `add the Tests: trailer to commit messages (${target.manager} commit-msg)`,
      ...(current !== undefined ? { before: current } : {}),
      after: insertBlock(current, block(prefix)),
      risk: "medium",
      mode: 0o755,
    },
  };
}

/**
 * Removes the trailer step from every place it can be. `pending` holds files other removals of
 * the same uninstall already changed; the returned map holds each changed file's new text.
 */
export async function planTrailerUninstall(
  root: string,
  manager?: TrailerManager,
  pending: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const read = async (file: string) => pending.get(file) ?? readText(join(root, file));
  const managers: TrailerManager[] = manager
    ? [manager]
    : ["husky", "lefthook", "simple-git-hooks", "git", "captainhook"];
  for (const m of managers) {
    if (m === "captainhook") {
      const text = await read(CAPTAINHOOK_FILE);
      if (text === undefined) continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const section = json["commit-msg"] as Record<string, unknown> | undefined;
      const actions = captainActions(json, "commit-msg");
      const kept = actions.filter((a) => !(typeof a.action === "string" && OWN.test(a.action)));
      if (!section || kept.length === actions.length) continue;
      if (kept.length) json["commit-msg"] = { ...section, actions: kept };
      else delete json["commit-msg"];
      out.set(CAPTAINHOOK_FILE, `${JSON.stringify(json, null, jsonIndent(text, "    "))}\n`);
      continue;
    }
    const target = await detectHookTarget(root, m, "commit-msg");
    if (target.manager !== m) continue;
    const text = out.get(target.file) ?? (await read(target.file));
    if (!text) continue;
    let after = text;
    if (m === "lefthook") after = uninstallLefthook(text);
    else if (m === "simple-git-hooks") {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      const hooks = pkg["simple-git-hooks"] as Record<string, string> | undefined;
      const v = hooks?.["commit-msg"];
      if (hooks && v && OWN.test(v)) {
        const rest = simpleWithout(v);
        if (rest) hooks["commit-msg"] = rest;
        else delete hooks["commit-msg"];
        after = `${JSON.stringify(pkg, null, jsonIndent(text, "  "))}\n`;
      }
    } else if (text.includes(START)) after = removeBlock(text);
    if (after !== text) out.set(target.file, after);
  }
  return out;
}
