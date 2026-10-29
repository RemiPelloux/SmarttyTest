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

/** Keeps changes under `prefix` (repo-relative) and rewrites them to be project-relative. */
export function scopeChangeSet(changeSet: ChangeSet, prefix: string): ChangeSet {
  if (!prefix) return changeSet;
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const strip = (s: string) => (s.startsWith(p) ? s.slice(p.length) : undefined);
  const changes: FileChange[] = [];
  for (const c of changeSet.changes) {
    const path = strip(c.path);
    if (path === undefined) continue;
    const previous = c.previousPath ? strip(c.previousPath) : undefined;
    if (c.type === "renamed" && previous === undefined) {
      const { previousPath: _dropped, ...rest } = c;
      changes.push({ ...rest, type: "added", path });
    } else changes.push({ ...c, path, ...(previous ? { previousPath: previous } : {}) });
  }
  return { ...changeSet, changes: changes.map(clean) };
}

function clean(c: FileChange): FileChange {
  const out: FileChange = { path: c.path, type: c.type };
  if (c.previousPath) out.previousPath = c.previousPath;
  if (c.changedRanges) out.changedRanges = c.changedRanges;
  if (c.previousHash) out.previousHash = c.previousHash;
  if (c.currentHash) out.currentHash = c.currentHash;
  return out;
}

export function emptyChangeSet(provider: string): ChangeSet {
  return { provider, changes: [], completeness: "complete", warnings: [] };
}
