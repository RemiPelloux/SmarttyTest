/**
 * @smarttest/vcs-svn — Subversion adapter. Spawns `svn` without a shell. Subversion has no
 * staging area: `--staged` and `--uncommitted` both mean "working copy against BASE".
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ChangeSet,
  type FileChange,
  type RevisionRef,
  relPosix,
  runProcess,
  SmartTestError,
  toPosix,
  type VersionControlAdapter,
  type VersionControlCapabilities,
  type WorkingState,
} from "@smarttest/shared";
import {
  type ChangeAnalysisInput,
  type ChangeProvider,
  type ChangeSource,
  describeSource,
  parseUnifiedRanges,
} from "@smarttest/vcs-core";

const IGNORED_DIRS = new Set(["node_modules", ".svn", ".git", ".smarttest", "dist", "coverage"]);

/** Parses `svn status` (working copy) or `svn diff --summarize` lines into changes. */
export function parseSvnStatus(
  output: string,
  summarize = false,
): { changes: FileChange[]; unversioned: string[] } {
  const changes: FileChange[] = [];
  const unversioned: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith("Performing") || raw.startsWith("---")) continue;
    const code = raw[0];
    const path = toPosix((summarize ? raw.slice(8) : raw.slice(8)).trim());
    if (!path) continue;
    if (code === "?") unversioned.push(path);
    else if (code === "A") changes.push({ type: "added", path });
    else if (code === "D" || code === "!") changes.push({ type: "deleted", path });
    else if (code === "M" || code === "R" || (summarize && raw[1] === "M"))
      changes.push({ type: "modified", path });
  }
  return { changes, unversioned };
}

export class SvnAdapter implements VersionControlAdapter, ChangeProvider {
  readonly id = "svn";
  constructor(private readonly projectRoot: string) {}

  private async svn(args: string[], allowFail = false): Promise<string> {
    const res = await runProcess("svn", ["--non-interactive", ...args], { cwd: this.projectRoot });
    if (res.code !== 0 && !allowFail)
      throw new SmartTestError(
        `svn ${args.join(" ")} failed: ${res.stderr.trim() || `exit ${res.code}`}`,
        {
          code: "ST_VCS_FAILED",
          category: "infrastructure",
          hint: "Make sure svn is installed and the project is inside a Subversion working copy.",
        },
      );
    return res.code === 0 ? res.stdout : "";
  }

  async detect(root: string = this.projectRoot): Promise<boolean> {
    try {
      const r = await runProcess("svn", ["info", "--show-item", "wc-root", "--non-interactive"], {
        cwd: root,
      });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  getCapabilities(): VersionControlCapabilities {
    return {
      branches: "partial",
      stagedChanges: false,
      untrackedFiles: true,
      renameDetection: false,
      mergeBase: false,
      fileContentAtRevision: true,
    };
  }

  async getWorkingState(): Promise<WorkingState> {
    const root = (await this.svn(["info", "--show-item", "wc-root"], true)).trim();
    const rev = (await this.svn(["info", "--show-item", "revision"], true)).trim();
    const status = await this.svn(["status", "-q"], true);
    return {
      provider: "svn",
      root: toPosix(root || this.projectRoot),
      ...(rev ? { head: { provider: "svn", ref: rev, kind: "commit" } } : {}),
      dirty: status.trim() !== "",
      warnings: [],
    };
  }

  async getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null> {
    const r = await runProcess("svn", ["cat", "-r", revision.ref, path, "--non-interactive"], {
      cwd: this.projectRoot,
    });
    return r.code === 0 ? Buffer.from(r.stdout, "utf8") : null;
  }

  private async expandDir(rel: string): Promise<string[]> {
    const abs = join(this.projectRoot, rel);
    const s = await stat(abs).catch(() => undefined);
    if (!s) return [];
    if (!s.isDirectory()) return [rel];
    const out: string[] = [];
    for (const e of await readdir(abs)) {
      if (IGNORED_DIRS.has(e)) continue;
      out.push(...(await this.expandDir(rel ? `${rel}/${e}` : e)));
    }
    return out;
  }

  private ranges(diff: string) {
    return parseUnifiedRanges(diff, (h) => {
      const p = h.replace(/\t.*$/, "").trim();
      return p === "/dev/null" ? undefined : toPosix(p);
    });
  }

  async getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet> {
    return this.collect(target ? `${base.ref}:${target.ref}` : base.ref, !target);
  }

  private async collect(rev: string, workingCopy: boolean): Promise<ChangeSet> {
    let changes: FileChange[];
    let unversioned: string[] = [];
    if (workingCopy && rev === "BASE") {
      ({ changes, unversioned } = parseSvnStatus(await this.svn(["status"])));
    } else {
      changes = parseSvnStatus(await this.svn(["diff", "--summarize", "-r", rev]), true).changes;
      if (workingCopy) unversioned = parseSvnStatus(await this.svn(["status"])).unversioned;
    }
    const diffArgs = rev === "BASE" ? ["diff", "-x", "-U0"] : ["diff", "-r", rev, "-x", "-U0"];
    const ranges = this.ranges(await this.svn(diffArgs, true));
    for (const c of changes) {
      const r = ranges.get(c.path);
      if (r && c.type !== "deleted") c.changedRanges = r;
    }
    for (const u of unversioned)
      for (const f of await this.expandDir(u)) changes.push({ type: "added", path: f });
    return {
      provider: "svn",
      changes,
      completeness: "complete",
      warnings: [],
      baseRevision: rev.split(":")[0] as string,
    };
  }

  async getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput> {
    if (source.kind === "snapshot") throw new Error("SvnAdapter does not handle snapshot sources");
    let before = "BASE";
    let changeSet: ChangeSet;
    if (source.kind === "base") {
      before = source.ref;
      changeSet = await this.collect(
        source.target ? `${source.ref}:${source.target}` : source.ref,
        !source.target,
      );
      changeSet.targetRevision = source.target ?? "working-copy";
    } else {
      changeSet = await this.collect("BASE", true);
      changeSet.targetRevision = "working-copy";
    }
    const readBefore = async (path: string): Promise<string | undefined> => {
      const r = await runProcess("svn", ["cat", "-r", before, path, "--non-interactive"], {
        cwd: this.projectRoot,
      });
      return r.code === 0 ? r.stdout : undefined;
    };
    const desc =
      source.kind === "base" ? describeSource({ ...source, direct: true }) : "BASE…working copy";
    return { changeSet, readBefore, description: `svn · ${desc}` };
  }

  /** Project directory relative to the working-copy root. */
  async prefix(): Promise<string> {
    const root = (await this.svn(["info", "--show-item", "wc-root"], true)).trim();
    return root ? (relPosix(root, this.projectRoot) ?? "") : "";
  }
}
