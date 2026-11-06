/**
 * `smarttest sync` after an upgrade: the proposals of `upgrade.ts` computed for an open project,
 * and the write of the accepted ones. Hook blocks are re-planned at write time, the config text
 * is checked to be the one the proposals were computed from: a file edited meanwhile is left as
 * it is.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gitProjectFiles } from "@smarttest/shared";
import type { SmartTest } from "./smarttest.js";
import type { SyncResult } from "./sync.js";
import {
  type ConfigEdit,
  configUpgrades,
  trailerEvidence,
  type UpgradeProposal,
} from "./upgrade.js";

export interface UpgradePlan {
  proposals: UpgradeProposal[];
  /** The config text the proposals were computed from (undefined: no config file). */
  configText?: string;
  /** Config edits by proposal key (not part of any JSON document). */
  edits: Map<string, ConfigEdit>;
}

const START = "# >>> smarttest >>>";
const END = "# <<< smarttest <<<";

/** The SmartTest block of a hook script, or "" when there is none. */
function blockOf(text: string | undefined): string {
  if (!text) return "";
  const lines = text.split("\n");
  const s = lines.findIndex((l) => l.trim() === START);
  const e = lines.findIndex((l, i) => i > s && l.trim() === END);
  return s >= 0 && e > s ? lines.slice(s, e + 1).join("\n") : "";
}

/** A parallel pre-push form: SmartTest started as a background job under the replaced PID. */
const parallel = (block: string) => /^\s*[A-Za-z_]\w*=\$!\s*$/m.test(block);

export async function planUpgrades(st: SmartTest): Promise<UpgradePlan> {
  const { raw, path } = st.loaded;
  const files = (await gitProjectFiles(st.root)) ?? [];
  const read = (f: string) => {
    try {
      return readFileSync(join(st.root, f), "utf8");
    } catch {
      return undefined;
    }
  };
  const hookScope = await st.hookScopeSuggestion().catch(() => undefined);
  const upgrades = configUpgrades({
    raw,
    files,
    ...(hookScope ? { hookScope } : {}),
    trailerEvidence: trailerEvidence(files, read),
  });
  const configText = path ? await readFile(path, "utf8").catch(() => undefined) : undefined;
  const rel = path ? relative(st.root, path).split("\\").join("/") : undefined;
  const proposals: UpgradeProposal[] = [];
  const edits = new Map<string, ConfigEdit>();
  for (const u of upgrades) {
    const after = configText !== undefined ? u.edit(configText) : undefined;
    const base = { id: u.id, key: u.key, title: u.title, reason: u.reason };
    if (configText === undefined || rel === undefined)
      proposals.push({
        ...base,
        manual:
          "no SmartTest configuration file: `smarttest init` writes one, then run `smarttest sync` again",
      });
    else if (after === undefined || after === configText)
      proposals.push({
        ...base,
        manual: `edit ${rel} by hand (the change could not be placed safely)`,
      });
    else {
      edits.set(u.key, u.edit);
      proposals.push({
        ...base,
        plan: {
          path: rel,
          action: "modify",
          reason: u.title,
          before: configText,
          after,
          risk: "medium",
        },
      });
    }
  }
  for (const stage of ["pre-commit", "pre-push"] as const) {
    const hp = await st.hookInstallPlan({ stage }).catch(() => undefined);
    if (!hp?.installed || hp.plan.action !== "modify" || hp.plan.after === undefined) continue;
    const toParallel =
      stage === "pre-push" &&
      parallel(blockOf(hp.plan.after)) &&
      !parallel(blockOf(hp.plan.before));
    proposals.push({
      id: "hook-block",
      key: `hook-block:${stage}`,
      stage,
      title: toParallel
        ? `Run SmartTest in parallel with the other ${stage} steps again (${hp.file})`
        : `Update the SmartTest ${stage} hook (${hp.file})`,
      reason: [
        toParallel
          ? "the test step SmartTest replaced ran in the background beside the other steps (`step & PID=$!` … `wait $PID`); the current block starts SmartTest as that background job instead of before them"
          : `the installed block was written by an older SmartTest (${hp.plan.reason})`,
        ...hp.notes,
      ].join("; "),
      plan: hp.plan,
    });
  }
  return { proposals, ...(configText !== undefined ? { configText } : {}), edits };
}

/**
 * Writes the accepted proposals (keys; `drift` for the configuration drift of `sync`), each file
 * once and atomically. Returns the files written, and the proposals left unwritten with why.
 */
export async function applyUpgrades(
  st: SmartTest,
  sync: SyncResult,
  plan: UpgradePlan,
  accepted: ReadonlySet<string>,
): Promise<{ applied: string[]; skipped: { key: string; why: string }[] }> {
  const applied: string[] = [];
  const skipped: { key: string; why: string }[] = [];
  const configKeys = plan.proposals
    .filter((p) => p.id !== "hook-block" && p.plan && accepted.has(p.key))
    .map((p) => p.key);
  const drift = accepted.has("drift") && !!sync.after;
  const path = st.loaded.path;
  if ((drift || configKeys.length) && path) {
    const rel = relative(st.root, path).split("\\").join("/");
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === undefined || current !== (sync.before ?? plan.configText)) {
      for (const k of [...(drift ? ["drift"] : []), ...configKeys])
        skipped.push({ key: k, why: `${rel} changed since the proposal; nothing written` });
    } else {
      let text = drift ? (sync.after as string) : current;
      for (const k of configKeys) {
        const next = plan.edits.get(k)?.(text);
        if (next === undefined) skipped.push({ key: k, why: `could not be placed in ${rel}` });
        else text = next;
      }
      if (text !== current)
        applied.push(
          ...(await st.applyFiles([
            {
              path: rel,
              action: "modify",
              reason: "sync configuration",
              before: current,
              after: text,
              risk: "medium",
            },
          ])),
        );
    }
  }
  for (const p of plan.proposals) {
    if (p.id !== "hook-block" || !p.stage || !accepted.has(p.key)) continue;
    // Re-planned now: the file is read again, so a hook edited meanwhile is never overwritten.
    const hp = await st.hookInstallPlan({ stage: p.stage }).catch(() => undefined);
    if (!hp?.installed || hp.plan.action !== "modify") {
      skipped.push({ key: p.key, why: "the hook changed since the proposal" });
      continue;
    }
    // Not init's step: `hook uninstall` undoes it, as after `hook install`.
    const written = await st.applyFiles([hp.plan], { journal: false });
    if (written.length) applied.push(...written);
    else skipped.push({ key: p.key, why: `${hp.file} changed since the proposal` });
  }
  return { applied, skipped };
}
