/**
 * `smarttest sync`: compares the configuration with what the project looks like now (runners,
 * sub-projects, version control) and proposes a patch of the config file. The patch edits only
 * the keys it changes, so hand edits elsewhere in the file are kept.
 */
import type { ResolvedConfig, SmartTestConfig } from "@smarttest/config";
import type { ProjectProfile } from "@smarttest/project-detector";

export interface Drift {
  key: string;
  current: string;
  proposed: string;
  reason: string;
}

export interface SyncResult {
  drift: Drift[];
  /** Config file text after the patch (undefined when nothing changes or it cannot be patched). */
  after?: string;
  before?: string;
  path?: string;
  /** Changes that could not be written into the file automatically. */
  manual: string[];
}

const list = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

export function detectDrift(
  config: ResolvedConfig,
  raw: SmartTestConfig,
  profile: ProjectProfile,
  detectedProjects?: SmartTestConfig["projects"],
): Drift[] {
  const drift: Drift[] = [];
  const detected = [...new Set(profile.runners.map((r) => r.adapter))];
  if (raw.adapters?.length) {
    const missing = detected.filter((a) => !raw.adapters?.includes(a));
    const gone = raw.adapters.filter((a) => !detected.includes(a));
    if (missing.length || gone.length)
      drift.push({
        key: "adapters",
        current: list(raw.adapters),
        proposed: list(detected),
        reason: [
          missing.length ? `${missing.join(", ")} found in the project but not enabled` : "",
          gone.length ? `${gone.join(", ")} no longer set up` : "",
        ]
          .filter(Boolean)
          .join("; "),
      });
  }
  for (const r of raw.runners ?? []) {
    const ok = profile.runners.some((p) => p.adapter === r.adapter && p.dir === (r.dir ?? ""));
    if (!ok)
      drift.push({
        key: `runners (${r.adapter} in ${r.dir || "."})`,
        current: "declared",
        proposed: "check by hand",
        reason: "this runner is declared in the config but no longer detected",
      });
  }
  const provider = raw.vcs?.provider;
  if (provider === "native" && profile.vcs.provider === "git")
    drift.push({
      key: "vcs.provider",
      current: '"native"',
      proposed: '"auto"',
      reason: "the project is now a Git repository",
    });
  if (provider === "git" && profile.vcs.provider !== "git")
    drift.push({
      key: "vcs.provider",
      current: '"git"',
      proposed: '"auto"',
      reason: "no Git repository found; native snapshots will be used",
    });
  if (raw.projects && detectedProjects) {
    const added = Object.keys(detectedProjects).filter((d) => !(d in (raw.projects ?? {})));
    if (added.length)
      drift.push({
        key: "projects",
        current: `${Object.keys(raw.projects).length} project(s)`,
        proposed: `add ${added.join(", ")}`,
        reason: "new sub-projects with their own test conventions",
      });
  }
  void config;
  return drift;
}

/** Applies drift to the config file text (TypeScript/JavaScript object literal or JSON). */
export function patchConfig(
  text: string,
  drift: readonly Drift[],
  detectedProjects?: SmartTestConfig["projects"],
): { after: string; manual: string[] } {
  let after = text;
  const manual: string[] = [];
  const json = /^\s*\{/.test(text);
  if (json) {
    const obj = JSON.parse(text) as Record<string, unknown>;
    for (const d of drift) {
      if (d.key === "adapters") obj.adapters = JSON.parse(d.proposed);
      else if (d.key === "vcs.provider")
        obj.vcs = { ...(obj.vcs as object), provider: JSON.parse(d.proposed) };
      else if (d.key === "projects" && detectedProjects)
        obj.projects = { ...detectedProjects, ...(obj.projects as object) };
      else manual.push(`${d.key}: ${d.reason}`);
    }
    return { after: `${JSON.stringify(obj, null, 2)}\n`, manual };
  }
  for (const d of drift) {
    if (d.key === "adapters") {
      const re = /adapters\s*:\s*\[[^\]]*\]/;
      if (re.test(after)) after = after.replace(re, `adapters: ${d.proposed}`);
      else manual.push(`adapters: set to ${d.proposed}`);
    } else if (d.key === "vcs.provider") {
      const re = /(provider\s*:\s*)["'](?:native|git)["']/;
      if (re.test(after)) after = after.replace(re, `$1${d.proposed}`);
      else manual.push(`vcs.provider: set to ${d.proposed}`);
    } else if (d.key === "projects" && detectedProjects) {
      const m = /projects\s*:\s*\{/.exec(after);
      const added = Object.entries(detectedProjects).filter(
        ([dir]) =>
          !after.includes(JSON.stringify(dir)) && !new RegExp(`\\b${dir}\\s*:`).test(after),
      );
      if (m && added.length)
        after = `${after.slice(0, m.index + m[0].length)}\n${added
          .map(([dir, p]) => `    ${JSON.stringify(dir)}: ${JSON.stringify(p)},`)
          .join("\n")}${after.slice(m.index + m[0].length)}`;
      else manual.push(`projects: add ${added.map(([d]) => d).join(", ")}`);
    } else manual.push(`${d.key}: ${d.reason}`);
  }
  return { after, manual };
}
