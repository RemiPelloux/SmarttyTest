/**
 * @smarttest/vcs-hg — Mercurial adapter. Spawns `hg` without a shell. Mercurial has no staging
 * area: `--staged` and `--uncommitted` both mean "working directory against the parent".
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
  parseUnifiedRanges,
  scopeChangeSet,
} from "@smarttest/vcs-core";

const HG_ENV = { HGPLAIN: "1" };

/** Parses `hg status` output (M/A/R/!/?). */
export function parseHgStatus(output: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const code = line[0];
    const path = toPosix(line.slice(2));
    if (code === "M") out.push({ type: "modified", path });
    else if (code === "A" || code === "?") out.push({ type: "added", path });
    else if (code === "R" || code === "!") out.push({ type: "deleted", path });
  }
  return out;
}

export class HgAdapter implements VersionControlAdapter, ChangeProvider {
  readonly id = "hg";
  private repoRoot: string | undefined;
  constructor(private readonly projectRoot: string) {}

  private async hg(args: string[], allowFail = false, cwd?: string): Promise<string> {
    const res = await runProcess("hg", args, {
      cwd: cwd ?? this.projectRoot,
      env: { ...process.env, ...HG_ENV },
    });
    if (res.code !== 0 && !allowFail)
      throw new SmartTestError(
        `hg ${args.join(" ")} failed: ${res.stderr.trim() || `exit ${res.code}`}`,
        {
          code: "ST_VCS_FAILED",
          category: "infrastructure",
          hint: "Make sure Mercurial is installed and the project is inside a Mercurial repository.",
        },
      );
    return res.code === 0 ? res.stdout : "";
  }

  async detect(root: string = this.projectRoot): Promise<boolean> {
    try {
      const r = await runProcess("hg", ["root"], { cwd: root, env: { ...process.env, ...HG_ENV } });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async root(): Promise<string> {
    this.repoRoot ??= (await this.hg(["root"])).trim();
    return this.repoRoot;
  }

  async prefix(): Promise<string> {
    const { realpath } = await import("node:fs/promises");
    return relPosix(await realpath(await this.root()), await realpath(this.projectRoot)) ?? "";
  }

  getCapabilities(): VersionControlCapabilities {
    return {
      branches: true,
      stagedChanges: false,
      untrackedFiles: true,
      renameDetection: "partial",
      mergeBase: true,
      fileContentAtRevision: true,
    };
  }

  async getWorkingState(): Promise<WorkingState> {
    const node = (await this.hg(["log", "-r", ".", "-T", "{node}"], true)).trim();
    const branch = (await this.hg(["branch"], true)).trim();
    const status = await this.hg(["status"], true, await this.root());
    return {
      provider: "hg",
      root: toPosix(await this.root()),
      ...(node
        ? { head: { provider: "hg", ref: branch || node, kind: branch ? "branch" : "commit" } }
        : {}),
      dirty: status.trim() !== "",
      warnings: [],
    };
  }

  async getFileContent(path: string, revision: RevisionRef): Promise<Uint8Array | null> {
    const prefix = await this.prefix();
    const r = await runProcess(
      "hg",
      ["cat", "-r", revision.ref, prefix ? `${prefix}/${path}` : path],
      {
        cwd: await this.root(),
        env: { ...process.env, ...HG_ENV },
      },
    );
    return r.code === 0 ? Buffer.from(r.stdout, "utf8") : null;
  }

  /** The common ancestor of `ref` and the working directory parent (direct: `ref` itself). */
  async resolveBase(ref: string, direct = false): Promise<string> {
    const node = (
      await this.hg(["log", "-r", direct ? ref : `ancestor(${ref}, .)`, "-T", "{node}"], true)
    ).trim();
    if (!node)
      throw new SmartTestError(`Revision "${ref}" not found in this repository`, {
        code: "ST_VCS_BASE_MISSING",
        category: "infrastructure",
        hint: "Pull it first (`hg pull`), or use a revision that exists locally.",
      });
    return node;
  }

  async getChanges(base: RevisionRef, target?: RevisionRef): Promise<ChangeSet> {
    return this.collect(base.ref, target?.ref);
  }

  private async collect(base: string, target?: string): Promise<ChangeSet> {
    const root = await this.root();
    const revs = target ? ["--rev", base, "--rev", target] : ["--rev", base];
    const changes = parseHgStatus(
      await this.hg(
        [
          "status",
          ...revs,
          ...(target ? [] : ["--unknown"]),
          "--modified",
          "--added",
          "--removed",
          "--deleted",
        ],
        false,
        root,
      ),
    );
    const ranges = parseUnifiedRanges(
      await this.hg(["diff", "--git", "-U0", ...revs], true, root),
      (h) => {
        const p = h.trim();
        return p === "/dev/null" ? undefined : toPosix(p.replace(/^b\//, ""));
      },
    );
    for (const c of changes) {
      const r = ranges.get(c.path);
      if (r && c.type !== "deleted") c.changedRanges = r;
    }
    return {
      provider: "hg",
      changes,
      completeness: "complete",
      warnings: [],
      baseRevision: base,
      ...(target ? { targetRevision: target } : {}),
    };
  }

  async getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput> {
    if (source.kind === "snapshot") throw new Error("HgAdapter does not handle snapshot sources");
    const before =
      source.kind === "base"
        ? await this.resolveBase(source.ref, source.direct)
        : (await this.hg(["log", "-r", ".", "-T", "{node}"])).trim();
    const changeSet = await this.collect(
      before,
      source.kind === "base" ? source.target : undefined,
    );
    if (!changeSet.targetRevision) changeSet.targetRevision = "working-directory";
    const prefix = await this.prefix();
    const root = await this.root();
    const readBefore = async (path: string): Promise<string | undefined> => {
      const r = await runProcess("hg", ["cat", "-r", before, prefix ? `${prefix}/${path}` : path], {
        cwd: root,
        env: { ...process.env, ...HG_ENV },
      });
      return r.code === 0 ? r.stdout : undefined;
    };
    const desc = source.kind === "base" ? describeSource(source) : "parent…working directory";
    return {
      changeSet: scopeChangeSet(changeSet, prefix),
      readBefore,
      description: `hg · ${desc}`,
    };
  }
}
