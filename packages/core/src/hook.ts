/**
 * Commit-hook support (0.9.0, sprint S24): testing exactly what will be committed or pushed,
 * project checks for the affected projects, hook records and the status of the hook setup.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { matchGlob, readJson, runProcess, SmartTestError, writeJson } from "@smarttest/shared";
import type { ChangeAnalysisInput } from "@smarttest/vcs-core";

/** Git puts these in a hook's environment; a temporary worktree must not inherit them. */
export const GIT_HOOK_ENV = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
] as const;

/** A copy of `env` without the variables Git sets for a hook (never mutates `process.env`). */
export function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GIT_HOOK_ENV) delete out[k];
  return out;
}

/** One line of the pre-push hook's stdin: `<local ref> <local sha> <remote ref> <remote sha>`. */
export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/**
 * True when this process was started by Git as a hook. Git sets `GIT_PREFIX` (empty at the
 * repository root) and `GIT_EXEC_PATH`; a normal shell does not.
 */
export function isHookContext(): boolean {
  return (
    process.env.GIT_PREFIX !== undefined ||
    process.env.GIT_INDEX_FILE !== undefined ||
    process.env.GIT_EXEC_PATH !== undefined
  );
}

/**
 * Reads the refs Git sends to a pre-push hook. Never blocks a normal `smarttest run --push`:
 * stdin is only read in a hook, and a timeout protects against a pipe that stays open.
 */
export async function readPrePushRefs(timeoutMs = 2_000): Promise<PushRef[]> {
  const stdin = process.stdin;
  if (stdin.isTTY || stdin.destroyed || stdin.readableEnded) return [];
  const text = await new Promise<string>((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.once("error", finish);
    stdin.resume();
  });
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef = "", localSha = "", remoteRef = "", remoteSha = ""] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * A pre-push hook can only analyse the checkout it runs in. Refuse to report a pass when the push
 * also sends another commit: that content was not tested (PRD §32.2).
 */
export async function assertPushIsHead(cwd: string, refs: readonly PushRef[]): Promise<void> {
  if (!refs.length) return;
  const head = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim();
  const other: string[] = [];
  for (const ref of refs) {
    // Deleting a remote ref pushes no content.
    if (!ref.localSha || /^0+$/.test(ref.localSha)) continue;
    const commit = (
      await git(cwd, ["rev-parse", "--verify", "-q", `${ref.localSha}^{commit}`])
    ).stdout.trim();
    if (commit !== head)
      other.push(`${ref.localRef || ref.localSha} -> ${ref.remoteRef || "remote"}`);
  }
  if (other.length)
    throw new SmartTestError(
      `The pre-push hook can only test the checked-out commit, but this push also sends ${other.join(", ")}`,
      {
        code: "ST_HOOK_PUSH_REF_UNSUPPORTED",
        category: "usage",
        hint: "Check out the ref being pushed, or push HEAD only (`git push origin HEAD`). SmartTest will not report a pass for a commit it did not test.",
      },
    );
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return runProcess("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    ...(env ? { env } : {}),
  });
}

const failure = (what: string, stderr: string) =>
  new SmartTestError(`${what}: ${stderr.trim() || "git exited with an error"}`, {
    code: "ST_HOOK_ISOLATION_FAILED",
    category: "infrastructure",
    hint: "Make sure Git is installed, the repository is healthy and the working tree is clean enough to create a temporary checkout.",
  });

const names = (out: string) => out.split("\0").filter(Boolean);

/** Files that differ between the working tree and what is being tested (unstaged or untracked). */
export async function setAside(
  repoCwd: string,
  kind: "staged" | "push",
): Promise<{ unstaged: string[]; untracked: string[]; staged: string[] }> {
  const lines = async (args: string[]) => {
    const r = await git(repoCwd, [...args, "-z"]);
    if (r.code !== 0) throw failure(`git ${args.join(" ")} failed`, r.stderr);
    return names(r.stdout);
  };
  const unstaged = await lines(["diff", "--name-only"]);
  const untracked = await lines(["ls-files", "--others", "--exclude-standard"]);
  // For a push, staged-but-uncommitted content is also *not* what is being pushed.
  const staged = kind === "push" ? await lines(["diff", "--cached", "--name-only"]) : [];
  return { unstaged, untracked, staged };
}

export interface Isolation {
  /** Project root inside the temporary checkout. */
  root: string;
  note: string;
  cleanup(): Promise<void>;
}

/** Repository-relative paths deleted from the index (renames remove their previous name). */
async function stagedRemovals(repoRoot: string): Promise<string[]> {
  // Use the hook's environment: it may point GIT_INDEX_FILE at the index being committed.
  const r = await git(repoRoot, ["diff", "--cached", "--name-status", "-z", "-M"]);
  if (r.code !== 0) throw failure("could not read the staged changes", r.stderr);
  const parts = r.stdout.split("\0").filter((p) => p !== "");
  const remove: string[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = (parts[i++] as string)[0];
    if (code === "R" || code === "C") {
      const previous = parts[i++] as string;
      i++; // current path
      if (code === "R") remove.push(previous);
    } else {
      const path = parts[i++] as string;
      if (code === "D") remove.push(path);
    }
  }
  return [...new Set(remove)];
}

/**
 * A temporary checkout holding exactly the content under test: HEAD plus the staged changes
 * (`staged`), or HEAD alone (`push`). Nothing in the user's working tree or index is touched;
 * no stash is used. Binary files, modes, symlinks and renames are preserved by Git itself.
 *
 * A repository without commits has no HEAD to check out: the staged content is materialised from
 * the index with `git checkout-index` instead (there is no Git metadata in that temporary tree).
 */
export async function isolate(options: {
  projectRoot: string;
  repoRoot: string;
  prefix: string;
  kind: "staged" | "push";
  input: ChangeAnalysisInput;
  nodeModulesDirs: readonly string[];
  aside: { unstaged: string[]; untracked: string[]; staged: string[] };
}): Promise<Isolation> {
  const tmp = await mkdtemp(join(tmpdir(), "smarttest-hook-"));
  const wt = join(tmp, "repo");
  const root = options.prefix ? join(wt, options.prefix) : wt;
  const clean = cleanGitEnv();
  let worktree = false;

  const cleanup = async (): Promise<void> => {
    if (worktree) {
      const removed = await git(
        options.repoRoot,
        ["worktree", "remove", "--force", wt],
        clean,
      ).catch(() => undefined);
      if (removed?.code !== 0)
        await rm(wt, { recursive: true, force: true }).catch(() => undefined);
      await git(options.repoRoot, ["worktree", "prune"], clean).catch(() => undefined);
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const head = (
      await git(options.repoRoot, ["rev-parse", "--verify", "-q", "HEAD"], clean)
    ).stdout.trim();
    if (options.kind === "push") {
      if (!head)
        throw new SmartTestError("There is no commit to push yet", {
          code: "ST_HOOK_NO_COMMIT",
          category: "usage",
          hint: "Make the first commit, then run the pre-push hook again.",
        });
      const add = await git(
        options.repoRoot,
        ["worktree", "add", "--detach", "-q", wt, "HEAD"],
        clean,
      );
      if (add.code !== 0) throw failure("could not create a temporary checkout", add.stderr);
      worktree = true;
    } else if (head) {
      const add = await git(
        options.repoRoot,
        ["worktree", "add", "--detach", "-q", wt, "HEAD"],
        clean,
      );
      if (add.code !== 0) throw failure("could not create a temporary checkout", add.stderr);
      worktree = true;
      // Apply exactly the index on top of HEAD. `--all` avoids passing one argument per staged
      // file (which hits E2BIG on very large commits). checkout-index preserves modes, symlinks
      // and binary content; paths deleted from the index are removed from the checkout.
      const removed = await stagedRemovals(options.repoRoot);
      // Remove old paths before overlaying the index: a former file may now be a
      // directory, or a directory's last tracked child may be replaced by a file.
      for (const path of removed) {
        await rm(join(wt, path), { recursive: true, force: true });
        for (let parent = dirname(join(wt, path)); parent !== wt; parent = dirname(parent)) {
          try {
            await rmdir(parent);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTEMPTY" || code === "EEXIST") break;
            if (code !== "ENOENT") throw error;
          }
        }
      }
      const co = await git(options.repoRoot, [
        "checkout-index",
        "--all",
        "--force",
        `--prefix=${wt.replace(/\\/g, "/")}/`,
      ]);
      if (co.code !== 0) throw failure("could not check out the staged content", co.stderr);
    } else {
      // Unborn HEAD: there is no commit to check out. The index is the content under test.
      await mkdir(wt, { recursive: true });
      const co = await git(options.repoRoot, [
        "checkout-index",
        "--all",
        "--force",
        `--prefix=${wt.replace(/\\/g, "/")}/`,
      ]);
      if (co.code !== 0) throw failure("could not check out the staged content", co.stderr);
    }
    await mkdir(root, { recursive: true });

    for (const d of options.nodeModulesDirs) {
      const src = join(options.projectRoot, d, "node_modules");
      const dest = join(root, d, "node_modules");
      if (
        existsSync(src) &&
        !(await lstat(dest).catch(() => undefined)) &&
        existsSync(join(root, d))
      )
        await symlink(src, dest, process.platform === "win32" ? "junction" : "dir");
    }

    const parts: string[] = [];
    const { unstaged, untracked, staged } = options.aside;
    if (unstaged.length) parts.push(`${unstaged.length} file(s) with unstaged edits`);
    if (untracked.length) parts.push(`${untracked.length} untracked file(s)`);
    if (staged.length) parts.push(`${staged.length} staged, uncommitted file(s)`);
    const what = options.kind === "staged" ? "the staged content" : "the commits being pushed";
    return {
      root,
      note: `Tested ${what} in a temporary checkout; set aside: ${parts.join(", ") || "nothing"}`,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ── Project checks ─────────────────────────────────────────────────────────────────────────

export interface HookCheck {
  name: string;
  /** Shell command run in each affected project; `{files}` becomes the changed files there. */
  run: string;
  /** Only these project directories ("" for the root). Default: every affected project. */
  projects?: string[];
  /** Glob (relative to the project) the `{files}` list is filtered with. */
  files?: string;
  /** Which hook runs it (default "pre-commit"). */
  stage?: "pre-commit" | "pre-push" | "both";
}

export interface CheckResult {
  name: string;
  project: string;
  command: string;
  status: "passed" | "failed";
  durationMs: number;
  output?: string;
}

/** A file changed by the commit/push; deleted files still make their project affected. */
export interface ChangedFile {
  path: string;
  deleted?: boolean;
}

/** The deepest project directory containing a file ("" for the root). */
export function projectOf(file: string, projects: readonly string[]): string {
  let best = "";
  for (const p of projects) if (p && file.startsWith(`${p}/`) && p.length > best.length) best = p;
  return best;
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function planChecks(
  checks: readonly HookCheck[],
  stage: "pre-commit" | "pre-push",
  changed: readonly ChangedFile[],
  projects: readonly string[],
): { name: string; project: string; command: string }[] {
  const byProject = new Map<string, ChangedFile[]>();
  for (const f of changed) {
    const p = projectOf(f.path, projects);
    byProject.set(p, [...(byProject.get(p) ?? []), f]);
  }
  const out: { name: string; project: string; command: string }[] = [];
  for (const c of checks) {
    const s = c.stage ?? "pre-commit";
    if (s !== "both" && s !== stage) continue;
    for (const [project, files] of byProject) {
      if (c.projects && !c.projects.includes(project)) continue;
      const local = files
        .filter((f) => !f.deleted)
        .map((f) => (project ? f.path.slice(project.length + 1) : f.path))
        .filter((f) => !c.files || matchGlob(f, c.files));
      // A command that takes files has nothing to run when every changed file was deleted or
      // filtered out; a command without `{files}` (type-check, build) still covers the project.
      if (c.run.includes("{files}") && !local.length) continue;
      if (!c.run.includes("{files}") && c.files && !local.length) continue;
      out.push({
        name: c.name,
        project,
        command: c.run.replaceAll("{files}", local.map(quote).join(" ")),
      });
    }
  }
  return out;
}

export async function runChecks(
  root: string,
  planned: readonly { name: string; project: string; command: string }[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  return Promise.all(
    planned.map(async (p) => {
      const t = performance.now();
      const done = (status: "passed" | "failed", output?: string): CheckResult => ({
        ...p,
        status,
        durationMs: Math.round(performance.now() - t),
        ...(output ? { output } : {}),
      });
      if (signal?.aborted) return done("failed", "cancelled before it started");
      try {
        const r = await runProcess("sh", ["-c", p.command], {
          cwd: join(root, p.project),
          timeoutMs,
          env: cleanGitEnv(),
          ...(signal ? { signal } : {}),
        });
        if (r.cancelled) return done("failed", "cancelled before it completed");
        if (r.timedOut) return done("failed", `timed out after ${timeoutMs} ms`);
        const output = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-15).join("\n");
        return done(r.code === 0 ? "passed" : "failed", r.code === 0 ? undefined : output);
      } catch (error) {
        return done("failed", `could not start the check: ${(error as Error).message}`);
      }
    }),
  );
}

// ── Records ────────────────────────────────────────────────────────────────────────────────

export interface HookRecord {
  at: string;
  stage: "pre-commit" | "pre-push";
  durationMs: number;
  selected: number;
  passed: boolean;
  /** Tree of the staged content (pre-commit) or the pushed commit (pre-push). */
  tree?: string;
}

export interface HookRecords {
  version: 1;
  runs: HookRecord[];
  bypasses: { at: string; stage: string; reason: string }[];
}

export async function loadHookRecords(storeDir: string): Promise<HookRecords> {
  const r = await readJson<HookRecords>(join(storeDir, "state", "hooks.json"));
  return r?.version === 1 ? r : { version: 1, runs: [], bypasses: [] };
}

export async function saveHookRecords(storeDir: string, r: HookRecords): Promise<void> {
  r.runs = r.runs.slice(-200);
  r.bypasses = r.bypasses.slice(-100);
  await writeJson(join(storeDir, "state", "hooks.json"), r);
}

/** Tree hash of what is being committed (uses the hook's index) or of HEAD. */
export async function treeOf(
  cwd: string,
  stage: "pre-commit" | "pre-push",
): Promise<string | undefined> {
  const r =
    stage === "pre-commit"
      ? await git(cwd, ["write-tree"])
      : await git(cwd, ["rev-parse", "HEAD^{tree}"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Recent commits whose tree never passed through the hook (bypassed, or hook not installed). */
export async function commitsWithoutHook(
  cwd: string,
  records: HookRecords,
  limit = 30,
): Promise<{ checked: number; without: { sha: string; subject: string }[] }> {
  const first = records.runs[0]?.at;
  if (!first) return { checked: 0, without: [] };
  const r = await git(cwd, [
    "log",
    `-${limit}`,
    "--no-merges",
    `--since=${first}`,
    "--format=%H%x09%T%x09%s",
  ]);
  const trees = new Set(records.runs.filter((x) => x.passed).map((x) => x.tree));
  const rows = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  return {
    checked: rows.length,
    without: rows
      .filter((x) => !trees.has(x[1]))
      .map((x) => ({ sha: (x[0] ?? "").slice(0, 10), subject: x[2] ?? "" })),
  };
}

export const median = (xs: readonly number[]) =>
  xs.length ? ([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number) : 0;

/** Number of SmartTest invocations written for a hook stage (duplicate blocks are a finding). */
export function hookInvocations(text: string, stage: "pre-commit" | "pre-push"): number {
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
  const inStage =
    stage === "pre-commit"
      ? lines.filter((l) => /smarttest\s+run\b[^\n]*--staged/.test(l))
      : lines.filter((l) => /smarttest\s+run\b[^\n]*--push/.test(l));
  return inStage.length;
}
