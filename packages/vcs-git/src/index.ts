/**
 * @smarttest/vcs-git — Git adapter (spec §7.5). Spawns `git` without a shell.
 */
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
  parseNameStatusZ,
  parseZeroContextRanges,
  scopeChangeSet,
} from "@smarttest/vcs-core";

const GIT_CONFIG = ["-c", "core.quotePath=false", "-c", "color.ui=false"];

export class GitAdapter implements VersionControlAdapter, ChangeProvider {
  readonly id = "git";
  private repoRoot: string | undefined;

  constructor(private readonly projectRoot: string) {}

  private async git(args: string[], allowFail = false): Promise<string> {
    const res = await runProcess("git", [...GIT_CONFIG, ...args], { cwd: this.projectRoot });
    if (res.code !== 0 && !allowFail) {
      throw new SmartTestError(
        `git ${args.join(" ")} failed: ${res.stderr.trim() || `exit ${res.code}`}`,
        {
          code: "ST_GIT_FAILED",
          category: "infrastructure",
          hint: "Make sure git is installed and the project is inside a Git repository.",
        },
      );
    }
    return res.code === 0 ? res.stdout : "";
  }

  async detect(root: string = this.projectRoot): Promise<boolean> {
    try {
      const res = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
      return res.code === 0 && res.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async root(): Promise<string> {
    if (!this.repoRoot) this.repoRoot = (await this.git(["rev-parse", "--show-toplevel"])).trim();
    return this.repoRoot;
  }

  /** Project directory relative to the repository root ("" when they're the same). */
  async prefix(): Promise<string> {
    const { realpath } = await import("node:fs/promises");
    const repo = await realpath(await this.root());
    const project = await realpath(this.projectRoot);
    return relPosix(repo, project) ?? "";
  }

  async hasHead(): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "-q", "HEAD"], true)).trim() !== "";
  }

  async getWorkingState(): Promise<WorkingState> {
    const warnings: string[] = [];
    const root = await this.root();
    const head = (await this.git(["rev-parse", "HEAD"], true)).trim();
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], true)).trim();
    const status = await this.git(["status", "--porcelain"], true);
    if (!head) warnings.push("Repository has no commits yet");
    const shallow =
      (await this.git(["rev-parse", "--is-shallow-repository"], true)).trim() === "true";
    if (shallow)
      warnings.push(
        "Shallow clone — comparisons against older bases may fail (fetch more history)",
      );
    return {
      provider: "git",
      root: toPosix(root),
      ...(head
        ? {
            head: {
              provider: "git",
              ref: branch && branch !== "HEAD" ? branch : head,
              kind: branch && branch !== "HEAD" ? "branch" : "commit",
            },
          }
        : {}),
      dirty: status.trim() !== "",
      warnings,
    };
  }

  getCapabilities(): VersionControlCapabilities {
    return {
      branches: true,
      stagedChanges: true,
      untrackedFiles: true,
      renameDetection: true,
      mergeBase: true,
      fileContentAtRevision: true,
    };
  }

  async getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null> {
    const prefix = await this.prefix();
    const repoPath = prefix ? `${prefix}/${path}` : path;
    const rev = revision.kind === "staged" ? "" : revision.ref;
    const res = await runProcess("git", [...GIT_CONFIG, "show", `${rev}:${repoPath}`], {
      cwd: this.projectRoot,
    });
    return res.code === 0 ? Buffer.from(res.stdout, "utf8") : null;
  }

  async resolveBase(ref: string, direct = false): Promise<string> {
    const exists = (
      await this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], true)
    ).trim();
    if (!exists) {
      throw new SmartTestError(`Base ref "${ref}" not found in this repository`, {
        code: "ST_GIT_BASE_MISSING",
        category: "infrastructure",
        hint: `Fetch it first (e.g. \`git fetch origin ${ref.replace(/^origin\//, "")}\`) or use fetch-depth: 0 in CI.`,
      });
    }
    if (direct) return exists;
    const mb = (await this.git(["merge-base", ref, "HEAD"], true)).trim();
    if (!mb) {
      throw new SmartTestError(`No merge-base between "${ref}" and HEAD`, {
        code: "ST_GIT_NO_MERGE_BASE",
        category: "infrastructure",
        hint: "The clone may be shallow. Fetch full history (fetch-depth: 0) or use --base-mode direct.",
      });
    }
    return mb;
  }

  async getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet> {
    const range = target ? [base.ref, target.ref] : [base.ref];
    return this.diff(range, !target, base.ref);
  }

  private async diff(
    range: string[],
    includeUntracked: boolean,
    baseRevision?: string,
    cached = false,
  ): Promise<ChangeSet> {
    const flags = cached ? ["--cached"] : [];
    const nameStatus = await this.git(["diff", ...flags, "--name-status", "-z", "-M", ...range]);
    const changes = parseNameStatusZ(nameStatus);
    const ranges = parseZeroContextRanges(
      await this.git(["diff", ...flags, "-U0", "-M", "--no-ext-diff", ...range]),
    );
    for (const c of changes) {
      const r = ranges.get(c.path);
      if (r && c.type !== "deleted") c.changedRanges = r;
    }
    if (includeUntracked) {
      const untracked = (await this.git(["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean);
      for (const path of untracked) changes.push({ type: "added", path });
    }
    const cs: ChangeSet = { provider: "git", changes, completeness: "complete", warnings: [] };
    if (baseRevision) cs.baseRevision = baseRevision;
    return cs;
  }

  async getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput> {
    const prefix = await this.prefix();
    let changeSet: ChangeSet;
    let beforeRev: string | undefined;
    if (source.kind === "snapshot") throw new Error("GitAdapter does not handle snapshot sources");
    const hasHead = await this.hasHead();
    if (!hasHead) {
      const files = (
        await this.git(["ls-files", "--others", "--cached", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      changeSet = {
        provider: "git",
        changes: files.map((path): FileChange => ({ type: "added", path })),
        completeness: "unknown",
        warnings: ["Repository has no commits — there is no baseline to compare against"],
      };
    } else if (source.kind === "base") {
      beforeRev = await this.resolveBase(source.ref, source.direct);
      changeSet = await this.diff([beforeRev], true, beforeRev);
      changeSet.targetRevision = "working-tree";
    } else if (source.kind === "staged") {
      beforeRev = "HEAD";
      changeSet = await this.diff([], false, "HEAD", true);
      changeSet.targetRevision = "index";
    } else {
      beforeRev = "HEAD";
      changeSet = await this.diff(["HEAD"], true, "HEAD");
      changeSet.targetRevision = "working-tree";
    }
    const scoped = scopeChangeSet(changeSet, prefix);
    const readBefore = async (path: string): Promise<string | undefined> => {
      if (!beforeRev) return undefined;
      const repoPath = prefix ? `${prefix}/${path}` : path;
      const res = await runProcess("git", [...GIT_CONFIG, "show", `${beforeRev}:${repoPath}`], {
        cwd: this.projectRoot,
      });
      return res.code === 0 ? res.stdout : undefined;
    };
    return { changeSet: scoped, readBefore, description: `git · ${describeSource(source)}` };
  }

  async head(): Promise<string | undefined> {
    return (await this.git(["rev-parse", "HEAD"], true)).trim() || undefined;
  }
}

export async function isGitRepository(root: string): Promise<boolean> {
  return new GitAdapter(root).detect();
}
