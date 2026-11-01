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

/**
 * A change set restricted to some paths (`--only`). Only the changed set is restricted: the
 * dependency analysis still covers the whole project, so unresolved relationships still select.
 */
export interface ChangeScope {
  /** Requested project-relative paths (a file, or a directory and everything under it). */
  paths: string[];
  /** Changed files kept: they match a requested path. */
  matched: string[];
  /** Requested paths that match no changed file: nothing is selected for them. */
  unchanged: string[];
  /** Changed files left out: their tests were not considered. */
  excluded: string[];
}

export interface VersionControlCapabilities {
  branches: Capability;
  stagedChanges: Capability;
  untrackedFiles: Capability;
  renameDetection: Capability;
  mergeBase: Capability;
  fileContentAtRevision: Capability;
}

/** A version-control adapter (Plugin SDK v1, frozen at 1.0.0). */
export interface VersionControlAdapter {
  /** Plugin API version this adapter implements. */
  readonly apiVersion: 1;
  readonly id: string;
  detect(root: string): Promise<boolean>;
  getWorkingState(): Promise<WorkingState>;
  getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet>;
  getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null>;
  getCapabilities(): VersionControlCapabilities;
}
