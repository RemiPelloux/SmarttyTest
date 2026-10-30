/**
 * Git hook integration (`smarttest hook install | uninstall | status`). SmartTest writes one marked
 * block into the project's existing hook setup (husky, lefthook, simple-git-hooks or plain
 * .git/hooks) and can comment out the test steps it replaces. Uninstall removes the block and
 * restores those steps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExistingTestCommand } from "@smarttest/project-detector";
import { exists, readJson, readText, SmartTestError } from "@smarttest/shared";
import type { FilePlan } from "./index.js";

export type HookManager = "husky" | "lefthook" | "simple-git-hooks" | "git";

export type HookStage = "pre-commit" | "pre-push";

/** What the SmartTest block runs in each hook. `--hook` implies --non-interactive and --bail. */
export const HOOK_COMMANDS: Record<HookStage, string> = {
  "pre-commit": "npx --no-install smarttest run --staged --hook",
  "pre-push": "npx --no-install smarttest run --push --hook",
};
export const HOOK_COMMAND = HOOK_COMMANDS["pre-commit"];
/** Any SmartTest command written by any version of `hook install`. */
const ANY_SMARTTEST = /npx --no-install smarttest run[^&|;)\n]*/;
const START = "# >>> smarttest >>>";
const END = "# <<< smarttest <<<";
const REPLACED = ": # smarttest-replaced: ";
/** A replaced background step (`cmd &`) keeps a background job so `$!` and `wait` still work. */
const REPLACED_BG = "true & # smarttest-replaced: ";
const MARK = "# smarttest-replaced: ";
const LEFTHOOK_MARK = "# smarttest";

export interface HookTarget {
  manager: HookManager;
  /** Project-relative file that holds the hook (`../.git/hooks/…` for a project in a subdirectory). */
  file: string;
  evidence: string;
  stage: HookStage;
  /** A `core.hooksPath` outside the repository: SmartTest refuses to write there. */
  outside?: string;
}

export interface HookPlan extends HookTarget {
  installed: boolean;
  plan: FilePlan;
  /** Test steps the block replaces (commented out with --replace, listed otherwise). */
  replaced: { line: number; command: string }[];
  /** Test steps that still run whole suites and are left as they are. */
  remaining: { line: number; command: string }[];
  notes: string[];
}

function hookSection(text: string | undefined, stage: HookStage): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${stage}:\\s*(#.*)?$`).test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? "") || !(lines[end] ?? "").trim())) end++;
  return lines.slice(start, end).join("\n");
}

/** True when the hook runs SmartTest; commented-out lines do not count. */
const isInstalled = (text: string | undefined, stage: HookStage) => {
  if (!text) return false;
  const lines = text.split("\n");
  if (lines.some((l) => l.trim() === START)) return true;
  const command =
    stage === "pre-commit" ? /smarttest\s+run\b[^\n]*--staged/ : /smarttest\s+run\b[^\n]*--push/;
  return lines.some((l) => !l.trim().startsWith("#") && command.test(l));
};

/** Output of a Git command run in the project, or undefined when it fails. */
function gitOut(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** A path made real through its closest existing ancestor (the hook file may not exist yet). */
function realish(path: string): string {
  let dir = path;
  const rest: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...rest);
}

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The plain Git hook file for a stage, as Git itself resolves it: relative `core.hooksPath` is
 * relative to the top-level, and a linked worktree shares the main repository's hooks. Husky's
 * own `core.hooksPath` is left to the husky target.
 */
function gitHookTarget(root: string, stage: HookStage): HookTarget {
  const fallback: HookTarget = {
    manager: "git",
    file: `.git/hooks/${stage}`,
    evidence: "Git hooks directory .git/hooks",
    stage,
  };
  const top = gitOut(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return fallback;
  const hooksPath = gitOut(root, ["config", "--get", "core.hooksPath"]);
  const custom = !!hooksPath && !hooksPath.includes(".husky");
  let abs: string | undefined;
  if (custom) {
    const out = gitOut(root, ["rev-parse", "--git-path", `hooks/${stage}`]);
    if (out) abs = resolve(root, out);
  } else {
    const common = gitOut(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common) abs = join(common, "hooks", stage);
  }
  if (!abs) return fallback;
  abs = realish(abs);
  const file = relative(realpathSync(root), abs).replace(/\\/g, "/");
  const shown = relative(realpathSync(top), dirname(abs)).replace(/\\/g, "/");
  return {
    manager: "git",
    file,
    evidence: custom ? `core.hooksPath ${hooksPath}` : `Git hooks directory ${shown}`,
    stage,
    ...(custom && !inside(realpathSync(top), abs) ? { outside: abs } : {}),
  };
}

/** The project directory relative to the top-level of the worktree ("" at the top-level). */
const projectPrefix = (root: string) =>
  (gitOut(root, ["rev-parse", "--show-prefix"]) ?? "").replace(/\/$/, "");

/** Shells the SmartTest block can be inserted into (`#!/bin/sh`, `#!/usr/bin/env bash -e`, …). */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:ba|da|z|k|mk|a)?sh\b/;

/** Finds which hook manager the project uses (or plain Git hooks). */
export async function detectHookTarget(
  root: string,
  prefer?: HookManager,
  stage: HookStage = "pre-commit",
): Promise<HookTarget> {
  const pkg = await readJson<{
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    "simple-git-hooks"?: Record<string, string>;
  }>(join(root, "package.json"));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const lefthook = ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"];
  const candidates: HookTarget[] = [];
  if ((await exists(join(root, ".husky"))) || deps.husky)
    candidates.push({
      manager: "husky",
      file: `.husky/${stage}`,
      evidence: ".husky/ directory or husky dependency",
      stage,
    });
  for (const f of lefthook)
    if (await exists(join(root, f)))
      candidates.push({ manager: "lefthook", file: f, evidence: f, stage });
  if (!candidates.some((c) => c.manager === "lefthook") && deps.lefthook)
    candidates.push({
      manager: "lefthook",
      file: "lefthook.yml",
      evidence: "lefthook dependency",
      stage,
    });
  if (pkg?.["simple-git-hooks"] || deps["simple-git-hooks"])
    candidates.push({
      manager: "simple-git-hooks",
      file: "package.json",
      evidence: "simple-git-hooks in package.json",
      stage,
    });
  candidates.push(gitHookTarget(root, stage));
  return candidates.find((c) => c.manager === prefer) ?? (candidates[0] as HookTarget);
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Pre-push refs read once by the block, then given back to the rest of the user's script. */
const REFS = "smarttest_refs";
const PIPE_REFS = `printf '%s\\n' "$${REFS}" | `;

/**
 * The SmartTest block. Git runs hooks at the top-level of the worktree, so a project in a
 * subdirectory is entered first (in a subshell: the rest of the script keeps its directory).
 * A pre-push hook's refs arrive on stdin; the block reads them once, passes them to SmartTest and
 * restores them for the user's own steps (a `while read local_ref …` guard still sees them).
 */
const block = (stage: HookStage, prefix = "") => {
  const push = stage === "pre-push";
  const command = `${push ? PIPE_REFS : ""}${HOOK_COMMANDS[stage]}`;
  return [
    START,
    push
      ? "# Runs only the tests the pushed commits can affect (https://github.com/RemiPelloux/SmarttyTest)."
      : "# Runs only the tests the staged change can affect (https://github.com/RemiPelloux/SmarttyTest).",
    ...(push ? [`${REFS}=`, `[ -t 0 ] || ${REFS}=$(cat)`] : []),
    ...(prefix
      ? [
          `if [ -x ${shellQuote(`${prefix}/node_modules/.bin/smarttest`)} ]; then`,
          `  (cd ${shellQuote(prefix)} && ${command}) || exit 1`,
        ]
      : ["if [ -x node_modules/.bin/smarttest ]; then", `  ${command} || exit 1`]),
    "else",
    '  echo "smarttest is not installed (npm install); affected tests were not run" >&2',
    "fi",
    // A here-document keeps this POSIX sh; it must start in the first column.
    ...(push
      ? [`if [ -n "$${REFS}" ]; then`, "exec <<SMARTTEST_REFS", `$${REFS}`, "SMARTTEST_REFS", "fi"]
      : []),
    END,
  ].join("\n");
};

/** Replaces the first marked block with a fresh one (an upgrade from an older install). */
function replaceBlock(text: string, fresh: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === END);
  if (start < 0 || end < 0) return text;
  lines.splice(start, end - start + 1, fresh);
  return lines.join("\n");
}

/** simple-git-hooks: SmartTest first, then the existing command (with the pre-push refs). */
function composeSimple(stage: HookStage, existing: string | undefined): string {
  if (!existing) return HOOK_COMMANDS[stage];
  if (stage === "pre-commit") return `${HOOK_COMMANDS[stage]} && ${existing}`;
  return `${REFS}=$(cat); ${PIPE_REFS}${HOOK_COMMANDS[stage]} && ${PIPE_REFS}{ ${existing}; }`;
}

const SIMPLE_PUSH =
  /^smarttest_refs=\$\(cat\); printf '%s\\n' "\$smarttest_refs" \| npx --no-install smarttest run[^&|;)\n]*&& printf '%s\\n' "\$smarttest_refs" \| \{ ([\s\S]*); \}$/;

/** The user's own command in a simple-git-hooks value, without SmartTest's part. */
function simpleExisting(value: string): string | undefined {
  const wrapped = SIMPLE_PUSH.exec(value);
  if (wrapped) return wrapped[1];
  const cmd = ANY_SMARTTEST.exec(value)?.[0]?.trim();
  if (!cmd) return value;
  return value.replace(`${cmd} && `, "").replace(cmd, "").trim() || undefined;
}

/** Lines of a test command, including backslash-continued lines. */
function commandLines(lines: string[], start: number): number[] {
  const out = [start];
  for (let i = start; i < lines.length - 1 && (lines[i] ?? "").trimEnd().endsWith("\\"); i++)
    out.push(i + 1);
  return out;
}

/** Leave compound shell syntax and scripts with non-test work for manual review. */
function canReplace(step: ExistingTestCommand): boolean {
  if (step.replaceable === false) return false;
  const command = step.command.replace(/\d*>&\d+/g, "").replace(/&\s*$/, "");
  return (
    /^(?:npx|npm|pnpm|yarn|bun|jest|vitest|node|\.\/node_modules\/\.bin\/(?:jest|vitest))\b/.test(
      command,
    ) &&
    !/[;&|`\n]/.test(command) &&
    !command.includes("$(")
  );
}

function installScript(
  text: string | undefined,
  steps: ExistingTestCommand[],
  replace: boolean,
  stage: HookStage,
  addBlock = true,
  prefix = "",
): string {
  const lines = (text ?? "#!/bin/sh\n").split("\n");
  if (replace)
    for (const s of steps)
      for (const [k, i] of commandLines(lines, s.line - 1).entries()) {
        const l = lines[i] ?? "";
        if (l.includes("smarttest-replaced")) continue;
        const bg = /&\s*$/.test(s.command) && !/&&\s*$/.test(s.command);
        lines[i] =
          k === 0
            ? `${l.match(/^\s*/)?.[0] ?? ""}${bg ? REPLACED_BG : REPLACED}${l.trim()}`
            : `# ${l}`;
      }
  // After the shebang and husky's own preamble.
  let at = 0;
  if (lines[0]?.startsWith("#!")) at = 1;
  while (at < lines.length && /husky\.sh/.test(lines[at] ?? "")) at++;
  if (addBlock) lines.splice(at, 0, block(stage, prefix));
  const out = lines.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

function uninstallScript(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  let restoring = false;
  for (const l of lines) {
    if (l.trim() === START) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (l.trim() === END) inBlock = false;
      continue;
    }
    if (l.includes(MARK)) {
      out.push(`${l.match(/^\s*/)?.[0] ?? ""}${l.slice(l.indexOf(MARK) + MARK.length)}`);
      restoring = l.trimEnd().endsWith("\\");
      continue;
    }
    if (restoring && l.startsWith("# ")) {
      out.push(l.slice(2));
      restoring = l.trimEnd().endsWith("\\");
      continue;
    }
    restoring = false;
    out.push(l);
  }
  return out.join("\n");
}

function installLefthook(text: string | undefined, stage: HookStage): string {
  const entry = (indent: string) => [
    `${indent}smarttest: ${LEFTHOOK_MARK}`,
    `${indent}  run: ${HOOK_COMMANDS[stage]}`,
    // lefthook gives a command stdin only when asked: pre-push refs arrive there.
    ...(stage === "pre-push" ? [`${indent}  use_stdin: true`] : []),
  ];
  const lines = (text ?? "").split("\n");
  const pc = lines.findIndex((l) => new RegExp(`^${stage}:\\s*(#.*)?$`).test(l));
  if (pc === -1) {
    const body = [`${stage}:`, "  commands:", ...entry("    ")];
    const base = (text ?? "").replace(/\s*$/, "");
    return `${base ? `${base}\n\n` : ""}${body.join("\n")}\n`;
  }
  let end = pc + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? "") || (lines[end] ?? "") === "")) end++;
  const cmd = lines.slice(pc + 1, end).findIndex((l) => /^\s+commands:\s*(#.*)?$/.test(l));
  if (cmd === -1) {
    lines.splice(pc + 1, 0, "  commands:", ...entry("    "));
  } else {
    const at = pc + 1 + cmd;
    const indent = (lines[at] ?? "").match(/^\s*/)?.[0] ?? "  ";
    const child = (lines[at + 1] ?? "").match(/^\s*/)?.[0] ?? `${indent}  `;
    lines.splice(at + 1, 0, ...entry(child.length > indent.length ? child : `${indent}  `));
  }
  return lines.join("\n");
}

function uninstallLefthook(text: string, stage: HookStage): string {
  const lines = text.split("\n");
  const section = lines.findIndex((l) => new RegExp(`^${stage}:\\s*(#.*)?$`).test(l));
  if (section === -1) return text;
  let i = section + 1;
  while (
    i < lines.length &&
    (/^\s/.test(lines[i] ?? "") || !(lines[i] ?? "").trim()) &&
    !(lines[i] ?? "").trimEnd().endsWith(`smarttest: ${LEFTHOOK_MARK}`)
  )
    i++;
  if (!(lines[i] ?? "").trimEnd().endsWith(`smarttest: ${LEFTHOOK_MARK}`)) return text;
  lines.splice(i, 1 + lefthookChildren(lines, i));
  return lines.join("\n");
}

const indentOf = (l: string) => l.match(/^\s*/)?.[0].length ?? 0;

/** Number of lines nested under the lefthook entry at `at` (`run:`, `use_stdin:` …). */
function lefthookChildren(lines: string[], at: number): number {
  let n = 0;
  const indent = indentOf(lines[at] ?? "");
  while ((lines[at + n + 1] ?? "").trim() && indentOf(lines[at + n + 1] ?? "") > indent) n++;
  return n;
}

/** Adds `use_stdin: true` to a pre-push entry installed before SmartTest wrote it. */
function lefthookStdin(text: string): string {
  const lines = text.split("\n");
  const section = lines.findIndex((l) => /^pre-push:\s*(#.*)?$/.test(l));
  if (section < 0) return text;
  for (let i = section + 1; i < lines.length && /^(\s|$)/.test(lines[i] ?? ""); i++) {
    if (!(lines[i] ?? "").trimEnd().endsWith(`smarttest: ${LEFTHOOK_MARK}`)) continue;
    const children = lines.slice(i + 1, i + 1 + lefthookChildren(lines, i));
    if (children.some((l) => /^\s*use_stdin:/.test(l))) return text;
    const indent =
      (children[0] ?? "").match(/^\s*/)?.[0] ?? `${(lines[i] ?? "").match(/^\s*/)?.[0]}  `;
    lines.splice(i + 1 + children.length, 0, `${indent}use_stdin: true`);
    return lines.join("\n");
  }
  return text;
}

export async function planHookInstall(
  root: string,
  options: {
    manager?: HookManager;
    replace?: boolean;
    testCommands?: readonly ExistingTestCommand[];
    stage?: HookStage;
  } = {},
): Promise<HookPlan> {
  const stage = options.stage ?? "pre-commit";
  const target = await detectHookTarget(root, options.manager, stage);
  if (target.outside)
    throw new SmartTestError(
      `core.hooksPath points outside the repository (${target.outside}); SmartTest will not write there`,
      {
        code: "ST_HOOK_PATH_OUTSIDE_REPO",
        category: "usage",
        hint: "Hooks shared by several repositories are not edited per project. Add `npx --no-install smarttest run --staged --hook` (or `--push`) to that hook yourself, or use a hooks directory inside the repository.",
      },
    );
  const current = await readText(join(root, target.file));
  const section = target.manager === "lefthook" ? hookSection(current, stage) : current;
  const script = target.manager === "husky" || target.manager === "git";
  // Git runs hooks at the top-level of the worktree; the block enters the project first.
  const prefix = script ? projectPrefix(root) : "";
  const steps = (options.testCommands ?? []).filter(
    (c) =>
      c.source === target.file &&
      c.line > 0 &&
      (target.manager !== "lefthook" || section?.includes(c.command)),
  );
  const listed = steps.map((s) => ({ line: s.line, command: s.command }));
  const replaceable = steps.filter(canReplace);
  const safeListed = replaceable.map((s) => ({ line: s.line, command: s.command }));
  const notes: string[] = [];
  let installed: boolean;
  if (target.manager === "simple-git-hooks") {
    const pkg =
      (await readJson<Record<string, Record<string, string>>>(join(root, "package.json"))) ?? {};
    installed = ANY_SMARTTEST.test(pkg["simple-git-hooks"]?.[stage] ?? "");
  } else {
    installed = isInstalled(section, stage);
  }
  const base = { ...target, installed, notes };
  if (installed) {
    const old = ANY_SMARTTEST.exec(section ?? "")?.[0]
      ?.replace(/\s+\|\|.*$/, "")
      .trim();
    let upgrade: string | undefined;
    if (target.manager === "simple-git-hooks" && current) {
      const pkg = JSON.parse(current) as Record<string, unknown>;
      const hooks = pkg["simple-git-hooks"] as Record<string, string>;
      const value = hooks[stage] ?? "";
      const wanted = composeSimple(stage, simpleExisting(value));
      if (wanted !== value) {
        hooks[stage] = wanted;
        upgrade = `${JSON.stringify(pkg, null, /^\{\n(\s+)/.exec(current)?.[1] ?? "  ")}\n`;
      }
    } else if (script && current?.split("\n").some((l) => l.trim() === START)) {
      // A marked block is rewritten whole: older blocks consumed pre-push stdin or did not
      // enter a project in a subdirectory.
      const fresh = replaceBlock(current, block(stage, prefix));
      if (fresh !== current) upgrade = fresh;
    } else if (old && old !== HOOK_COMMANDS[stage] && current) {
      upgrade = current.replace(section as string, () =>
        (section as string).replace(old, HOOK_COMMANDS[stage]),
      );
    }
    if (target.manager === "lefthook" && stage === "pre-push") {
      const withStdin = lefthookStdin(upgrade ?? current ?? "");
      if (withStdin !== (upgrade ?? current)) upgrade = withStdin;
    }
    const replaceExisting = options.replace && safeListed.length > 0 && script;
    if (replaceExisting)
      upgrade = installScript(upgrade ?? current, replaceable, true, stage, false);
    return {
      ...base,
      plan: {
        path: target.file,
        action: upgrade ? "modify" : "skip",
        reason: upgrade
          ? "upgrade the SmartTest hook profile"
          : "SmartTest already runs in this hook",
        ...(upgrade && current !== undefined ? { before: current, after: upgrade } : {}),
        risk: "medium",
      },
      replaced: replaceExisting ? safeListed : [],
      remaining: listed.filter(
        (s) => !replaceExisting || !safeListed.some((r) => r.line === s.line),
      ),
    };
  }
  const shebang = current?.split("\n", 1)[0] ?? "";
  if (script && shebang.startsWith("#!") && !SHELL_SHEBANG.test(shebang))
    throw new SmartTestError(
      `${target.file} is not a shell script (${shebang}); inserting the SmartTest block would break it`,
      {
        code: "ST_HOOK_NOT_SHELL",
        category: "usage",
        hint: "Call `npx --no-install smarttest run --staged --hook` (or `--push`) from that hook yourself and fail the hook when it exits non-zero.",
      },
    );
  let after: string;
  let replaced = options.replace ? safeListed : [];
  if (target.manager === "lefthook") {
    after = installLefthook(current, stage);
    if (listed.length)
      notes.push(
        "lefthook steps that run whole suites are listed, not changed; remove them by hand",
      );
    replaced = [];
  } else if (target.manager === "simple-git-hooks") {
    const pkgText = current ?? "{}";
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    const hooks = (pkg["simple-git-hooks"] as Record<string, string> | undefined) ?? {};
    const existing = hooks[stage];
    hooks[stage] = composeSimple(stage, existing);
    pkg["simple-git-hooks"] = hooks;
    const indent = /^\{\n(\s+)/.exec(pkgText)?.[1] ?? "  ";
    after = `${JSON.stringify(pkg, null, indent)}\n`;
    notes.push("run `npx simple-git-hooks` once to update .git/hooks");
    if (existing && /\b(jest|vitest|node\s+--test)\b/.test(existing))
      notes.push(`the existing ${stage} command still runs: ${existing}`);
    replaced = [];
  } else {
    after = installScript(
      current,
      options.replace ? replaceable : [],
      !!options.replace,
      stage,
      true,
      prefix,
    );
  }
  return {
    ...base,
    plan: {
      path: target.file,
      action: current === undefined ? "create" : "modify",
      reason: `run affected tests before each ${stage === "pre-commit" ? "commit" : "push"} (${target.manager})${replaced.length ? `, replacing ${replaced.length} full-suite step(s)` : ""}`,
      ...(current !== undefined ? { before: current } : {}),
      after,
      risk: "medium",
      ...(script ? { mode: 0o755 } : {}),
    },
    replaced,
    remaining: listed.filter((r) => !replaced.some((x) => x.line === r.line)),
  };
}

export async function planHookUninstall(
  root: string,
  manager?: HookManager,
  stages: readonly HookStage[] = ["pre-commit", "pre-push"],
): Promise<FilePlan[]> {
  const out: FilePlan[] = [];
  const managers: HookManager[] = manager
    ? [manager]
    : ["husky", "lefthook", "simple-git-hooks", "git"];
  const targets: HookTarget[] = (
    await Promise.all(
      managers.map(async (m) => {
        const found = await Promise.all(stages.map((st) => detectHookTarget(root, m, st)));
        // `detectHookTarget` falls back to plain Git when the preferred manager is absent; an
        // explicit uninstall must never touch a different manager's files.
        return found.filter((t) => t.manager === m);
      }),
    )
  )
    .flat()
    .filter((t, i, all) => all.findIndex((x) => x.file === t.file && x.stage === t.stage) === i);
  const edited = new Map<string, string>();
  for (const t of targets) {
    const text = edited.get(t.file) ?? (await readText(join(root, t.file)));
    if (!text) continue;
    let after = text;
    if (t.manager === "lefthook") after = uninstallLefthook(text, t.stage);
    else if (t.manager === "simple-git-hooks") {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      const hooks = pkg["simple-git-hooks"] as Record<string, string> | undefined;
      const v = hooks?.[t.stage];
      if (hooks && v && ANY_SMARTTEST.test(v)) {
        const rest = simpleExisting(v);
        if (rest) hooks[t.stage] = rest;
        else delete hooks[t.stage];
        const indent = /^\{\n(\s+)/.exec(text)?.[1] ?? "  ";
        after = `${JSON.stringify(pkg, null, indent)}\n`;
      }
    } else if (text.includes(START)) after = uninstallScript(text);
    if (after !== text) edited.set(t.file, after);
  }
  for (const [path, after] of edited) {
    const before = (await readText(join(root, path))) as string;
    if (after !== before)
      out.push({
        path,
        action: "modify",
        reason: "remove the SmartTest block",
        before,
        after,
        risk: "medium",
      });
  }
  return out;
}
