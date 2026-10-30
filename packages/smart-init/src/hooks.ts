/**
 * Git hook integration (`smarttest hook install | uninstall | status`). SmartTest writes one marked
 * block into the project's existing hook setup (husky, lefthook, simple-git-hooks or plain
 * .git/hooks) and can comment out the test steps it replaces. Uninstall removes the block and
 * restores those steps.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ExistingTestCommand } from "@smarttest/project-detector";
import { exists, readJson, readText } from "@smarttest/shared";
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
const ANY_SMARTTEST = /npx --no-install smarttest run[^&|;\n]*/;
const START = "# >>> smarttest >>>";
const END = "# <<< smarttest <<<";
const REPLACED = ": # smarttest-replaced: ";
/** A replaced background step (`cmd &`) keeps a background job so `$!` and `wait` still work. */
const REPLACED_BG = "true & # smarttest-replaced: ";
const MARK = "# smarttest-replaced: ";
const LEFTHOOK_MARK = "# smarttest";

export interface HookTarget {
  manager: HookManager;
  /** Project-relative file that holds the hook. */
  file: string;
  evidence: string;
  stage: HookStage;
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

const isInstalled = (text: string | undefined, stage: HookStage) =>
  !!text &&
  (text.includes(START) ||
    (stage === "pre-commit"
      ? /smarttest\s+run\b[^\n]*--staged/
      : /smarttest\s+run\b[^\n]*--push/
    ).test(text));

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
  let hooksDir = ".git/hooks";
  try {
    const p = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (p && !p.includes(".husky")) hooksDir = p.replace(/\/$/, "");
  } catch {
    /* not set */
  }
  candidates.push({
    manager: "git",
    file: `${hooksDir}/${stage}`,
    evidence: `Git hooks directory ${hooksDir}`,
    stage,
  });
  return candidates.find((c) => c.manager === prefer) ?? (candidates[0] as HookTarget);
}

const block = (stage: HookStage) =>
  [
    START,
    stage === "pre-commit"
      ? "# Runs only the tests the staged change can affect (https://github.com/RemiPelloux/SmarttyTest)."
      : "# Runs only the tests the pushed commits can affect (https://github.com/RemiPelloux/SmarttyTest).",
    "if [ -x node_modules/.bin/smarttest ]; then",
    `  ${HOOK_COMMANDS[stage]} || exit 1`,
    "else",
    '  echo "smarttest is not installed (npm install); affected tests were not run" >&2',
    "fi",
    END,
  ].join("\n");

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
  if (addBlock) lines.splice(at, 0, block(stage));
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
  lines.splice(i, ANY_SMARTTEST.test(lines[i + 1] ?? "") ? 2 : 1);
  return lines.join("\n");
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
  const current = await readText(join(root, target.file));
  const section = target.manager === "lefthook" ? hookSection(current, stage) : current;
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
      const command = ANY_SMARTTEST.exec(hooks[stage] ?? "")?.[0]?.trim();
      if (command && command !== HOOK_COMMANDS[stage]) {
        hooks[stage] = (hooks[stage] as string).replace(command, HOOK_COMMANDS[stage]);
        upgrade = `${JSON.stringify(pkg, null, /^\{\n(\s+)/.exec(current)?.[1] ?? "  ")}\n`;
      }
    } else if (old && old !== HOOK_COMMANDS[stage] && current) {
      upgrade = current.replace(section as string, () =>
        (section as string).replace(old, HOOK_COMMANDS[stage]),
      );
    }
    const replaceExisting =
      options.replace &&
      safeListed.length > 0 &&
      (target.manager === "husky" || target.manager === "git");
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
    hooks[stage] = existing ? `${HOOK_COMMANDS[stage]} && ${existing}` : HOOK_COMMANDS[stage];
    pkg["simple-git-hooks"] = hooks;
    const indent = /^\{\n(\s+)/.exec(pkgText)?.[1] ?? "  ";
    after = `${JSON.stringify(pkg, null, indent)}\n`;
    notes.push("run `npx simple-git-hooks` once to update .git/hooks");
    if (existing && /\b(jest|vitest|node\s+--test)\b/.test(existing))
      notes.push(`the existing ${stage} command still runs: ${existing}`);
    replaced = [];
  } else {
    after = installScript(current, options.replace ? replaceable : [], !!options.replace, stage);
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
      ...(target.manager === "husky" || target.manager === "git" ? { mode: 0o755 } : {}),
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
      const cmd = v ? ANY_SMARTTEST.exec(v)?.[0]?.trim() : undefined;
      if (hooks && v && cmd) {
        const rest = v.replace(`${cmd} && `, "").replace(cmd, "").trim();
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
