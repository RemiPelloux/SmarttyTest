/**
 * CaptainHook (`captainhook.json`), the hook manager of PHP projects. SmartTest's step is a CLI
 * action. An action that already runs the project's tests (`vendor/bin/phpunit`,
 * `php artisan test`, Pest, or a script that runs them, such as `scripts/test-changed.sh`) is
 * replaced in place, in the same hook; the command it replaces is kept in the action's label
 * (`SmartTest: affected tests, in place of: …`), so `smarttest hook uninstall` restores it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, readText } from "@smarttest/shared";
import type { FilePlan } from "./index.js";

export const CAPTAINHOOK_FILE = "captainhook.json";
/** The label CaptainHook shows for SmartTest's action; it keeps the command it replaced. */
const MARK = "SmartTest: affected tests, in place of: ";
const OWN = /smarttest(?:@[\w.-]+)?\s+run\b/;

type Stage = "pre-commit" | "pre-push";

interface Action {
  action: string;
  options?: unknown;
  conditions?: unknown;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The command SmartTest's action runs: the project's own SmartTest when it is installed with npm,
 * else the published package through `npx` (a PHP project needs Node, not a package.json).
 */
export async function captainHookCommand(root: string, stage: Stage): Promise<string> {
  const pkg = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  const local =
    existsSync(join(root, "node_modules", ".bin", "smarttest")) ||
    !!pkg?.devDependencies?.["@tkmremi/smarttest"] ||
    !!pkg?.dependencies?.["@tkmremi/smarttest"];
  const run = stage === "pre-commit" ? "run --staged --hook" : "run --push --hook";
  return local ? `npx --no-install smarttest ${run}` : `npx --yes @tkmremi/smarttest ${run}`;
}

/** Runs PHPUnit, Pest or `php artisan test` (a script's text, or a command line). */
const RUNS_TESTS = /\b(?:phpunit|paratest)\b|\bartisan\s+test\b|(?:^|[\s/])pest(?:\s|$)/m;

/** Whether an action runs the project's tests, directly or through a script it calls. */
async function runsTests(
  root: string,
  command: string,
  scripts: Record<string, unknown>,
): Promise<boolean> {
  if (OWN.test(command)) return false;
  if (RUNS_TESTS.test(command)) return true;
  // `bash scripts/test-changed.sh`, `env X=1 sh ./x.sh`, `./x.sh`
  const script = /(?:^|\s)((?:\.\/)?[\w./-]+\.sh)\b/.exec(command)?.[1];
  if (script) {
    const text = await readText(join(root, script.replace(/^\.\//, "")));
    return !!text && RUNS_TESTS.test(text);
  }
  // `composer test`, `composer run-script test:fast`
  const composer = /^composer\s+(?:run(?:-script)?\s+)?([\w:-]+)/.exec(command.trim())?.[1];
  if (composer && composer in scripts) {
    const body = JSON.stringify(scripts[composer]);
    if (RUNS_TESTS.test(body)) return true;
    for (const m of body.matchAll(/@([\w:-]+)/g))
      if (m[1] && m[1] in scripts && RUNS_TESTS.test(JSON.stringify(scripts[m[1]]))) return true;
    const sh = /([\w./-]+\.sh)/.exec(body)?.[1];
    if (sh) return RUNS_TESTS.test((await readText(join(root, sh.replace(/^\.\//, "")))) ?? "");
  }
  return false;
}

export interface CaptainHookPlan {
  file: string;
  plan: FilePlan;
  /** Per stage: the actions replaced, and whether SmartTest already ran there. */
  stages: { stage: Stage; replaced: string[]; installed: boolean }[];
}

/**
 * Plans SmartTest in `captainhook.json`. With `replace`, an action that runs tests is replaced in
 * place; a stage without one gets SmartTest's action at the end. `stages` defaults to the stages
 * whose actions run tests, else pre-commit.
 */
export async function planCaptainHook(
  root: string,
  options: { stages?: readonly Stage[]; replace?: boolean } = {},
): Promise<CaptainHookPlan | undefined> {
  const text = await readText(join(root, CAPTAINHOOK_FILE));
  if (text === undefined) return undefined;
  let json: Record<string, { enabled?: boolean; actions?: Action[] } | unknown>;
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return undefined;
  }
  const composer =
    (await readJson<{ scripts?: Record<string, unknown> }>(join(root, "composer.json")))?.scripts ??
    {};
  const testing: Stage[] = [];
  for (const stage of ["pre-commit", "pre-push"] as const) {
    const actions = ((json[stage] as { actions?: Action[] } | undefined)?.actions ?? []).filter(
      (a) => typeof a?.action === "string",
    );
    for (const a of actions) if (await runsTests(root, a.action, composer)) testing.push(stage);
  }
  const stages = options.stages ?? (testing.length ? [...new Set(testing)] : ["pre-commit"]);
  const result: CaptainHookPlan["stages"] = [];
  for (const stage of stages) {
    const section = (json[stage] ?? { enabled: true, actions: [] }) as {
      enabled?: boolean;
      actions?: Action[];
    };
    const actions = Array.isArray(section.actions) ? section.actions : [];
    const command = await captainHookCommand(root, stage);
    const installed = actions.some((a) => typeof a.action === "string" && OWN.test(a.action));
    const replaced: string[] = [];
    if (!installed) {
      let placed = false;
      for (const [i, a] of actions.entries()) {
        if (!options.replace || typeof a.action !== "string") continue;
        if (!(await runsTests(root, a.action, composer))) continue;
        replaced.push(a.action);
        actions[i] = {
          ...a,
          action: command,
          config: { ...(a.config ?? {}), label: `${MARK}${a.action}` },
        };
        placed = true;
      }
      if (!placed) actions.push({ action: command });
    }
    json[stage] = { ...section, enabled: section.enabled ?? true, actions };
    result.push({ stage, replaced, installed });
  }
  const indent = /^\{\n(\s+)/.exec(text)?.[1] ?? "    ";
  const after = `${JSON.stringify(json, null, indent)}\n`;
  const changed = after !== text && result.some((s) => !s.installed);
  const replacedAll = result.flatMap((s) => s.replaced);
  return {
    file: CAPTAINHOOK_FILE,
    stages: result,
    plan: changed
      ? {
          path: CAPTAINHOOK_FILE,
          action: "modify",
          reason: `run affected tests in CaptainHook's ${result.map((s) => s.stage).join(" and ")} hook${replacedAll.length ? `, replacing ${replacedAll.map((r) => `\`${r}\``).join(", ")}` : ""}`,
          before: text,
          after,
          risk: "medium",
        }
      : {
          path: CAPTAINHOOK_FILE,
          action: "skip",
          reason: "SmartTest already runs in CaptainHook's hooks",
          risk: "medium",
        },
  };
}

/** Removes SmartTest's actions from `captainhook.json`, restoring the ones it replaced. */
export async function planCaptainHookUninstall(root: string): Promise<FilePlan | undefined> {
  const text = await readText(join(root, CAPTAINHOOK_FILE));
  if (text === undefined) return undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const stage of ["pre-commit", "pre-push"]) {
    const section = json[stage] as { actions?: Action[] } | undefined;
    if (!Array.isArray(section?.actions)) continue;
    section.actions = section.actions.flatMap((a) => {
      if (typeof a.action !== "string" || !OWN.test(a.action)) return [a];
      const label = typeof a.config?.label === "string" ? a.config.label : "";
      if (!label.startsWith(MARK)) return [];
      const { label: _label, ...config } = a.config ?? {};
      const restored: Action = { ...a, action: label.slice(MARK.length) };
      if (Object.keys(config).length) restored.config = config;
      else delete restored.config;
      return [restored];
    });
  }
  const indent = /^\{\n(\s+)/.exec(text)?.[1] ?? "    ";
  const after = `${JSON.stringify(json, null, indent)}\n`;
  if (after === text) return undefined;
  return {
    path: CAPTAINHOOK_FILE,
    action: "modify",
    reason: "remove SmartTest's CaptainHook actions",
    before: text,
    after,
    risk: "medium",
  };
}
