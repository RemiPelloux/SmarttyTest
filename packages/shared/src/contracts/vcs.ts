import type { Capability, Completeness, SourceRange } from "../primitives.js";

/** Provider-specific revision reference. Git SHAs, SVN revisions and snapshot ids are NOT interchangeable (spec §7.3). */
export interface RevisionRef {
  provider: string;
  /** e.g. "main", "HEAD~1", "r142", "snap_01J…", or the special working-tree markers. */
  ref: string;
  kind: "branch" | "commit" | "revision" | "changelist" | "snapshot" | "working-tree" | "staged";
}

export interface WorkingState {
  provider: string;
  root: string;
  head?: RevisionRef;
  dirty: boolean;
  warnings: string[];
}

export interface FileChange {
  path: string;
  previousPath?: string;
  type: "added" | "modified" | "deleted" | "renamed";
  changedRanges?: SourceRange[];
  previousHash?: string;
  currentHash?: string;
}

export interface ChangeSet {
  provider: string;
  baseRevision?: string;
  targetRevision?: string;
  changes: FileChange[];
  completeness: Completeness;
  warnings: string[];
}

export interface VersionControlCapabilities {
  branches: Capability;
  stagedChanges: Capability;
  untrackedFiles: Capability;
  renameDetection: Capability;
  mergeBase: Capability;
  fileContentAtRevision: Capability;
}

export interface VersionControlAdapter {
  readonly id: string;
  detect(root: string): Promise<boolean>;
  getWorkingState(): Promise<WorkingState>;
  getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet>;
  getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null>;
  getCapabilities(): VersionControlCapabilities;
}
