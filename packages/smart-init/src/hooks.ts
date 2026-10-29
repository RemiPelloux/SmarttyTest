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

export const HOOK_COMMAND = "npx --no-install smarttest run --staged --non-interactive";
const START = "# >>> smarttest >>>";
const END = "# <<< smarttest <<<";
const REPLACED = ": # smarttest-replaced: ";
const LEFTHOOK_MARK = "# smarttest";

export interface HookTarget {
  manager: HookManager;
  /** Project-relative file that holds the pre-commit hook. */
  file: string;
  evidence: string;
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

const isInstalled = (text: string | undefined) =>
  !!text && (text.includes(START) || /smarttest\s+run\b[^\n]*--staged/.test(text));

/** Finds which hook manager the project uses (or plain Git hooks). */
export async function detectHookTarget(root: string, prefer?: HookManager): Promise<HookTarget> {
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
      file: ".husky/pre-commit",
      evidence: ".husky/ directory or husky dependency",
    });
  for (const f of lefthook)
    if (await exists(join(root, f))) candidates.push({ manager: "lefthook", file: f, evidence: f });
  if (!candidates.some((c) => c.manager === "lefthook") && deps.lefthook)
    candidates.push({ manager: "lefthook", file: "lefthook.yml", evidence: "lefthook dependency" });
  if (pkg?.["simple-git-hooks"] || deps["simple-git-hooks"])
    candidates.push({
      manager: "simple-git-hooks",
      file: "package.json",
      evidence: "simple-git-hooks in package.json",
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
    file: `${hooksDir}/pre-commit`,
    evidence: `Git hooks directory ${hooksDir}`,
  });
  return candidates.find((c) => c.manager === prefer) ?? (candidates[0] as HookTarget);
}

const block = () =>
  [
    START,
    "# Runs only the tests the staged change can affect (https://github.com/RemiPelloux/SmarttyTest).",
    "if [ -x node_modules/.bin/smarttest ]; then",
    `  ${HOOK_COMMAND} || exit 1`,
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

function installScript(
  text: string | undefined,
  steps: ExistingTestCommand[],
  replace: boolean,
): string {
  const lines = (text ?? "#!/bin/sh\n").split("\n");
  if (replace)
    for (const s of steps)
      for (const [k, i] of commandLines(lines, s.line - 1).entries()) {
        const l = lines[i] ?? "";
        if (l.includes("smarttest-replaced")) continue;
        lines[i] = k === 0 ? `${l.match(/^\s*/)?.[0] ?? ""}${REPLACED}${l.trim()}` : `# ${l}`;
      }
  // After the shebang and husky's own preamble.
  let at = 0;
  if (lines[0]?.startsWith("#!")) at = 1;
  while (at < lines.length && /husky\.sh/.test(lines[at] ?? "")) at++;
  lines.splice(at, 0, block());
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
    if (l.includes(REPLACED)) {
      out.push(`${l.match(/^\s*/)?.[0] ?? ""}${l.slice(l.indexOf(REPLACED) + REPLACED.length)}`);
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

function installLefthook(text: string | undefined): string {
  const entry = (indent: string) => [
    `${indent}smarttest: ${LEFTHOOK_MARK}`,
    `${indent}  run: ${HOOK_COMMAND}`,
  ];
  const lines = (text ?? "").split("\n");
  const pc = lines.findIndex((l) => /^pre-commit:\s*(#.*)?$/.test(l));
  if (pc === -1) {
    const body = ["pre-commit:", "  commands:", ...entry("    ")];
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

function uninstallLefthook(text: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trimEnd().endsWith(`smarttest: ${LEFTHOOK_MARK}`));
  if (i === -1) return text;
  lines.splice(i, lines[i + 1]?.includes(HOOK_COMMAND) ? 2 : 1);
  return lines.join("\n");
}

export async function planHookInstall(
  root: string,
  options: {
    manager?: HookManager;
    replace?: boolean;
    testCommands?: readonly ExistingTestCommand[];
  } = {},
): Promise<HookPlan> {
  const target = await detectHookTarget(root, options.manager);
  const current = await readText(join(root, target.file));
  const steps = (options.testCommands ?? []).filter((c) => c.source === target.file && c.line > 0);
  const listed = steps.map((s) => ({ line: s.line, command: s.command }));
  const notes: string[] = [];
  const installed =
    target.manager === "simple-git-hooks"
      ? JSON.stringify(
          (await readJson<Record<string, unknown>>(join(root, "package.json")))?.[
            "simple-git-hooks"
          ] ?? {},
        ).includes("smarttest run")
      : isInstalled(current);
  const base = { ...target, installed, notes };
  if (installed)
    return {
      ...base,
      plan: {
        path: target.file,
        action: "skip",
        reason: "SmartTest already runs in this hook",
        risk: "medium",
      },
      replaced: [],
      remaining: listed,
    };
  let after: string;
  let replaced = options.replace ? listed : [];
  if (target.manager === "lefthook") {
    after = installLefthook(current);
    if (listed.length)
      notes.push(
        "lefthook steps that run whole suites are listed, not changed; remove them by hand",
      );
    replaced = [];
  } else if (target.manager === "simple-git-hooks") {
    const pkgText = current ?? "{}";
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    const hooks = (pkg["simple-git-hooks"] as Record<string, string> | undefined) ?? {};
    const existing = hooks["pre-commit"];
    hooks["pre-commit"] = existing ? `${HOOK_COMMAND} && ${existing}` : HOOK_COMMAND;
    pkg["simple-git-hooks"] = hooks;
    const indent = /^\{\n(\s+)/.exec(pkgText)?.[1] ?? "  ";
    after = `${JSON.stringify(pkg, null, indent)}\n`;
    notes.push("run `npx simple-git-hooks` once to update .git/hooks");
    if (existing && /\b(jest|vitest|node\s+--test)\b/.test(existing))
      notes.push(`the existing pre-commit command still runs: ${existing}`);
    replaced = [];
  } else {
    after = installScript(current, options.replace ? steps : [], !!options.replace);
  }
  return {
    ...base,
    plan: {
      path: target.file,
      action: current === undefined ? "create" : "modify",
      reason: `run affected tests before each commit (${target.manager})${replaced.length ? `, replacing ${replaced.length} full-suite step(s)` : ""}`,
      ...(current !== undefined ? { before: current } : {}),
      after,
      risk: "medium",
      ...(target.manager === "husky" || target.manager === "git" ? { mode: 0o755 } : {}),
    },
    replaced,
    remaining: options.replace ? [] : listed,
  };
}

export async function planHookUninstall(root: string, manager?: HookManager): Promise<FilePlan[]> {
  const out: FilePlan[] = [];
  const targets: HookTarget[] = manager
    ? [await detectHookTarget(root, manager)]
    : await Promise.all(
        (["husky", "lefthook", "simple-git-hooks", "git"] as HookManager[]).map((m) =>
          detectHookTarget(root, m),
        ),
      );
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.file)) continue;
    seen.add(t.file);
    const text = await readText(join(root, t.file));
    if (!text) continue;
    let after = text;
    if (t.manager === "lefthook") after = uninstallLefthook(text);
    else if (t.manager === "simple-git-hooks") {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      const hooks = pkg["simple-git-hooks"] as Record<string, string> | undefined;
      const v = hooks?.["pre-commit"];
      if (hooks && v?.includes(HOOK_COMMAND)) {
        const rest = v.replace(`${HOOK_COMMAND} && `, "").replace(HOOK_COMMAND, "").trim();
        if (rest) hooks["pre-commit"] = rest;
        else delete hooks["pre-commit"];
        const indent = /^\{\n(\s+)/.exec(text)?.[1] ?? "  ";
        after = `${JSON.stringify(pkg, null, indent)}\n`;
      }
    } else if (text.includes(START)) after = uninstallScript(text);
    if (after !== text)
      out.push({
        path: t.file,
        action: "modify",
        reason: `remove the SmartTest block (${t.manager})`,
        before: text,
        after,
        risk: "medium",
      });
  }
  return out;
}
