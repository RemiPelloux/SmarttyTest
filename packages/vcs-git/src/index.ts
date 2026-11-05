/**
 * @smarttest/vcs-git — Git adapter (spec §7.5). Spawns `git` without a shell.
 */

import { join, posix } from "node:path";
import {
  assertSafeRevision,
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
  GITLINK_MODE,
  parseRawZ,
  parseZeroContextRanges,
  type RawChange,
  scopeChangeSet,
} from "@smarttest/vcs-core";
import { BlobReader } from "./cat-file.js";

const GIT_CONFIG = ["-c", "core.quotePath=false", "-c", "color.ui=false"];
/**
 * Output that does not depend on the user's Git configuration: repository-relative paths
 * (`diff.relative`), `a/` and `b/` prefixes (`diff.noprefix`, `diff.mnemonicPrefix`), no colour,
 * no external diff or text conversion, and submodules always reported (`diff.ignoreSubmodules`).
 */
const DIFF_FLAGS = [
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=none",
];

export class GitAdapter implements VersionControlAdapter, ChangeProvider {
  readonly apiVersion = 1;
  readonly id = "git";
  private repoRoot: string | undefined;

  constructor(private readonly projectRoot: string) {}

  private async git(args: string[], allowFail = false, input?: string): Promise<string> {
    const res = await runProcess("git", [...GIT_CONFIG, ...args], {
      cwd: this.projectRoot,
      ...(input !== undefined ? { input } : {}),
    });
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
    assertSafeRevision(ref, "Base");
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
    // The verified commit id, not the user's text, reaches the next command.
    const mb = (await this.git(["merge-base", exists, "HEAD"], true)).trim();
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
    assertSafeRevision(base.ref, "Base");
    if (target) assertSafeRevision(target.ref, "Target");
    const range = target ? [base.ref, target.ref] : [base.ref];
    return this.diff(range, !target, base.ref);
  }

  private async diff(
    range: string[],
    includeUntracked: boolean,
    baseRevision?: string,
    cached = false,
  ): Promise<ChangeSet> {
    const flags = [...(cached ? ["--cached"] : []), ...DIFF_FLAGS];
    const raw = parseRawZ(await this.git(["diff", ...flags, "--raw", "-z", "-M", ...range]));
    const changes: FileChange[] = [];
    const warnings: string[] = [];
    for (const r of raw) {
      if (r.oldMode !== GITLINK_MODE && r.newMode !== GITLINK_MODE) changes.push(r.change);
      else changes.push(...(await this.submoduleChanges(r, includeUntracked, warnings)));
    }
    const ranges = parseZeroContextRanges(
      await this.git(["diff", ...flags, "-U0", "-M", ...range]),
    );
    for (const c of changes) {
      const r = ranges.get(c.path);
      if (r && c.type !== "deleted" && !c.submodule) c.changedRanges = r;
    }
    if (includeUntracked) {
      // Repository-relative (`--full-name`) and repository-wide (`:/`), like the diff above: the
      // project may be a subfolder, and it can import files outside it.
      const untracked = (
        await this.git([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--full-name",
          "--",
          ":/",
        ])
      )
        .split("\0")
        .filter(Boolean);
      for (const path of untracked) changes.push({ type: "added", path });
    }
    const cs: ChangeSet = { provider: "git", changes, completeness: "complete", warnings };
    if (baseRevision) cs.baseRevision = baseRevision;
    return cs;
  }

  /** Submodule checkouts (repo-relative path → commit before the change), for `readBefore`. */
  private readonly submoduleBase = new Map<string, string>();

  /**
   * A submodule whose recorded commit moved: the files that changed inside it, when the checkout
   * has both commits. Otherwise one change flagged `submodule`, which selects every test using it.
   */
  private async submoduleChanges(
    r: RawChange,
    worktree: boolean,
    warnings: string[],
  ): Promise<FileChange[]> {
    const path = r.change.path;
    const fallback = (why: string): FileChange[] => {
      warnings.push(`Submodule ${path} changed, but ${why}: every test using it is selected`);
      return [{ ...r.change, submodule: true }];
    };
    if (r.oldMode !== GITLINK_MODE || r.newMode !== GITLINK_MODE)
      return fallback(r.oldMode === GITLINK_MODE ? "it was removed" : "it was added");
    const dir = join(await this.root(), path);
    const sub = async (args: string[]) =>
      runProcess("git", [...GIT_CONFIG, ...args], { cwd: dir }).catch(() => undefined);
    const top = await sub(["rev-parse", "--show-toplevel"]);
    const { realpath } = await import("node:fs/promises");
    const real = async (p: string) => realpath(p).catch(() => p);
    if (top?.code !== 0 || (await real(top.stdout.trim())) !== (await real(dir)))
      return fallback("it is not checked out");
    const zero = /^0+$/.test(r.newId);
    const range = zero ? [r.oldId] : [r.oldId, r.newId];
    for (const id of range) {
      const has = await sub(["cat-file", "-e", `${id}^{commit}`]);
      if (has?.code !== 0) return fallback(`commit ${id.slice(0, 12)} is not in its checkout`);
    }
    const listed = await sub(["diff", ...DIFF_FLAGS, "--raw", "-z", "-M", ...range]);
    if (listed?.code !== 0) return fallback("its changes could not be listed");
    const out: FileChange[] = [];
    for (const inner of parseRawZ(listed.stdout)) {
      const c = inner.change;
      // A nested submodule is not expanded further: it stands for everything under it.
      out.push({
        ...c,
        path: `${path}/${c.path}`,
        ...(c.previousPath ? { previousPath: `${path}/${c.previousPath}` } : {}),
        ...(inner.oldMode === GITLINK_MODE || inner.newMode === GITLINK_MODE
          ? { submodule: true }
          : {}),
      });
    }
    if (zero && worktree) {
      const untracked = await sub([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--full-name",
      ]);
      for (const p of (untracked?.stdout ?? "").split("\0").filter(Boolean))
        out.push({ type: "added", path: `${path}/${p}` });
    }
    this.submoduleBase.set(path, r.oldId);
    return out;
  }

  /**
   * Content of a repository path at a revision, looking inside an expanded submodule. Read
   * through one `git cat-file --batch` per repository (see cat-file.ts).
   */
  private async showAt(
    blobs: BlobReader,
    rev: string,
    repoPath: string,
  ): Promise<string | undefined> {
    for (const [sub, id] of this.submoduleBase) {
      if (!repoPath.startsWith(`${sub}/`)) continue;
      return blobs.read(join(await this.root(), sub), id, repoPath.slice(sub.length + 1));
    }
    return blobs.read(this.projectRoot, rev, repoPath);
  }

  async getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput> {
    const prefix = await this.prefix();
    let changeSet: ChangeSet;
    let beforeRev: string | undefined;
    if (source.kind === "snapshot") throw new Error("GitAdapter does not handle snapshot sources");
    const hasHead = await this.hasHead();
    if (!hasHead) {
      const files = (
        await this.git([
          "ls-files",
          "--others",
          "--cached",
          "--exclude-standard",
          "-z",
          "--full-name",
        ])
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
      if (source.target) {
        assertSafeRevision(source.target, "Target");
        // Revision-to-revision (history replay): untracked files in the working tree don't count.
        changeSet = await this.diff([beforeRev, source.target], false, beforeRev);
        changeSet.targetRevision = source.target;
      } else {
        changeSet = await this.diff([beforeRev], true, beforeRev);
        changeSet.targetRevision = "working-tree";
      }
    } else if (source.kind === "push") {
      const { base, note } = await this.pushBase(source.remoteShas);
      beforeRev = base;
      changeSet = await this.diff([base, "HEAD"], false, base);
      changeSet.targetRevision = "HEAD";
      if (note) changeSet.warnings.push(note);
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
    const blobs = new BlobReader(GIT_CONFIG);
    const readBefore = async (path: string): Promise<string | undefined> => {
      if (!beforeRev) return undefined;
      const repoPath = posix.normalize(prefix ? `${prefix}/${path}` : path);
      if (repoPath.startsWith("../")) return undefined;
      return this.showAt(blobs, beforeRev, repoPath);
    };
    return {
      changeSet: scoped,
      readBefore,
      description: `git · ${describeSource(source)}`,
      close: () => blobs.close(),
    };
  }

  /**
   * The hash of an empty tree in this repository's object format (SHA-1 or SHA-256).
   * Used as a conservative base when no upstream can be determined: every commit then counts.
   */
  private async emptyTree(): Promise<string> {
    const tree = (await this.git(["hash-object", "-t", "tree", "--stdin"], false, "")).trim();
    if (!tree)
      throw new SmartTestError("Could not compute the empty tree hash", {
        code: "ST_GIT_FAILED",
        category: "infrastructure",
        hint: "Make sure the repository is healthy and Git can write objects.",
      });
    return tree;
  }

  /**
   * Base of a push: the merge-base with the branch's upstream, else with `origin/HEAD`,
   * `origin/main` or `origin/master`. When there is no remote branch at all, an empty tree is
   * used so every commit since the first is included — the previous commit would silently miss
   * every earlier unpushed commit.
   */
  async pushBase(remoteShas?: readonly string[]): Promise<{ base: string; note?: string }> {
    if (remoteShas !== undefined) {
      // Multiple destinations can have different histories. Comparing the whole tree is a
      // conservative superset and avoids losing changes by choosing only one destination.
      if (
        remoteShas.length === 1 &&
        /^[0-9a-f]{40,64}$/i.test(remoteShas[0] ?? "") &&
        !/^0+$/.test(remoteShas[0] ?? "")
      ) {
        const sha = remoteShas[0] as string;
        const mb = (await this.git(["merge-base", sha, "HEAD"], true)).trim();
        if (mb) return { base: mb };
      }
      return {
        base: await this.emptyTree(),
        note: "New, unknown or multiple push targets: comparing with the whole history (empty tree)",
      };
    }
    const candidates = ["@{upstream}", "origin/HEAD", "origin/main", "origin/master"];
    for (const ref of candidates) {
      if (!(await this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], true)).trim())
        continue;
      const mb = (await this.git(["merge-base", ref, "HEAD"], true)).trim();
      if (mb)
        return {
          base: mb,
          ...(ref === "@{upstream}" ? {} : { note: `No upstream branch: compared with ${ref}` }),
        };
    }
    return {
      base: await this.emptyTree(),
      note: "No upstream or origin branch: comparing with the whole history (empty tree)",
    };
  }

  async head(): Promise<string | undefined> {
    return (await this.git(["rev-parse", "HEAD"], true)).trim() || undefined;
  }
}

export async function isGitRepository(root: string): Promise<boolean> {
  return new GitAdapter(root).detect();
}
