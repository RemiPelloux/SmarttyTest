/**
 * @smarttest/vcs-core — provider-neutral change model (spec §7.3–7.4).
 */
import type { ChangeSet, FileChange, SourceRange } from "@smarttest/shared";

export type {
  ChangeSet,
  FileChange,
  RevisionRef,
  VersionControlAdapter,
  VersionControlCapabilities,
  WorkingState,
} from "@smarttest/shared";

/** What to compare against. */
export type ChangeSource =
  | {
      kind: "base";
      ref: string;
      direct?: boolean /** compare against this revision instead of the working tree */;
      target?: string;
    }
  | { kind: "staged" }
  /** Committed push content. Hook callers supply actual remote SHAs; otherwise use upstream. */
  | { kind: "push"; remoteShas?: readonly string[] }
  | { kind: "uncommitted" }
  | { kind: "snapshot"; id?: string };

/** A ChangeSet plus the ability to read "before" content for semantic diff. */
export interface ChangeAnalysisInput {
  changeSet: ChangeSet;
  /** Content of a (project-relative) path before the change, or undefined when unavailable. */
  readBefore(path: string): Promise<string | undefined>;
  /** Human description, e.g. "git · main…working tree". */
  description: string;
}

export interface ChangeProvider {
  readonly id: string;
  getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput>;
}

export function describeSource(source: ChangeSource): string {
  switch (source.kind) {
    case "base":
      return `${source.direct ? source.ref : `merge-base(${source.ref})`}…${source.target ?? "working tree"}`;
    case "staged":
      return "HEAD…index (staged)";
    case "push":
      return source.remoteShas
        ? "remote push targets…HEAD (push)"
        : "merge-base(upstream)…HEAD (push)";
    case "uncommitted":
      return "HEAD…working tree";
    case "snapshot":
      return `snapshot ${source.id ?? "latest"}…working tree`;
  }
}

/** Parses `git diff --name-status -z [-M]` output. */
export function parseNameStatusZ(output: string): FileChange[] {
  const parts = output.split("\0").filter((p) => p !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++] as string;
    const code = status[0];
    if (code === "R" || code === "C") {
      const previousPath = parts[i++] as string;
      const path = parts[i++] as string;
      changes.push(
        code === "R" ? { type: "renamed", path, previousPath } : { type: "added", path },
      );
    } else {
      const path = parts[i++] as string;
      const type = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      changes.push({ type, path });
    }
  }
  return changes;
}

/** One entry of `git diff --raw -z --no-abbrev`: the change plus the modes and object ids. */
export interface RawChange {
  change: FileChange;
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
}

/** Mode of a gitlink (a submodule's recorded commit). */
export const GITLINK_MODE = "160000";

/** Parses `git diff --raw -z --no-abbrev [-M]` output (keeps modes, so submodules are visible). */
export function parseRawZ(output: string): RawChange[] {
  const parts = output.split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++] as string;
    if (!head.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldId = "", newId = "", status = ""] = head
      .slice(1)
      .split(" ");
    const code = status[0];
    let change: FileChange;
    if (code === "R" || code === "C") {
      const previousPath = parts[i++] as string;
      const path = parts[i++] as string;
      change = code === "R" ? { type: "renamed", path, previousPath } : { type: "added", path };
    } else {
      const path = parts[i++] as string;
      change = { type: code === "A" ? "added" : code === "D" ? "deleted" : "modified", path };
    }
    out.push({ change, oldMode, newMode, oldId, newId });
  }
  return out;
}

/** Parses `git diff -U0` hunks into changed ranges (0-based lines) of the *new* file. */
export function parseZeroContextRanges(diff: string): Map<string, SourceRange[]> {
  const out = new Map<string, SourceRange[]>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current) {
      const start = Math.max(0, Number(m[1]) - 1);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const end = count === 0 ? start : start + count - 1;
      out.get(current)?.push({
        start: { line: start, column: 0 },
        end: { line: end, column: Number.MAX_SAFE_INTEGER },
      });
    }
  }
  return out;
}

/**
 * Keeps changes under `prefix` (repo-relative) and rewrites them to be project-relative. Changes
 * elsewhere in the repository go to `outside`, relative to the project (`../shared/x.ts`): project
 * files can import them. A file moved out of the project is a deletion inside it.
 */
export function scopeChangeSet(changeSet: ChangeSet, prefix: string): ChangeSet {
  if (!prefix) return changeSet;
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const strip = (s: string) => (s.startsWith(p) ? s.slice(p.length) : undefined);
  const up = `${p
    .split("/")
    .filter(Boolean)
    .map(() => "..")
    .join("/")}/`;
  const away = (s: string) => strip(s) ?? `${up}${s}`;
  const changes: FileChange[] = [];
  const outside: FileChange[] = [...(changeSet.outside ?? [])];
  for (const c of changeSet.changes) {
    const path = strip(c.path);
    const previous = c.previousPath ? strip(c.previousPath) : undefined;
    if (path === undefined) {
      if (c.type === "renamed" && previous !== undefined) {
        changes.push({ type: "deleted", path: previous });
        outside.push({ type: "added", path: away(c.path) });
      } else {
        const moved = c.previousPath ? { previousPath: away(c.previousPath) } : {};
        outside.push(clean({ ...c, path: away(c.path), ...moved }));
      }
      continue;
    }
    if (c.type === "renamed" && previous === undefined) {
      const { previousPath: _dropped, ...rest } = c;
      changes.push({ ...rest, type: "added", path });
      if (c.previousPath) outside.push({ type: "deleted", path: away(c.previousPath) });
    } else changes.push({ ...c, path, ...(previous ? { previousPath: previous } : {}) });
  }
  return {
    ...changeSet,
    changes: changes.map(clean),
    ...(outside.length ? { outside } : {}),
  };
}

function clean(c: FileChange): FileChange {
  const out: FileChange = { path: c.path, type: c.type };
  if (c.previousPath) out.previousPath = c.previousPath;
  if (c.changedRanges) out.changedRanges = c.changedRanges;
  if (c.previousHash) out.previousHash = c.previousHash;
  if (c.currentHash) out.currentHash = c.currentHash;
  if (c.submodule) out.submodule = true;
  return out;
}

export function emptyChangeSet(provider: string): ChangeSet {
  return { provider, changes: [], completeness: "complete", warnings: [] };
}
export { parseUnifiedRanges } from "./unified.js";
