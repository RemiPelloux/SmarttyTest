/**
 * Commit-hook support (0.9.0, sprint S24): testing exactly what will be committed or pushed,
 * project checks for the affected projects, hook records and the status of the hook setup.
 */
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  mapLimit,
  matchGlob,
  readJson,
  runProcess,
  SmartTestError,
  writeJson,
} from "@smarttest/shared";
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
  // Paths are repository-relative even when the user configured `diff.relative`.
  return runProcess("git", ["-c", "core.quotePath=false", "-c", "diff.relative=false", ...args], {
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
  const [unstaged, untracked, staged] = await Promise.all([
    lines(["diff", "--name-only"]),
    lines(["ls-files", "--others", "--exclude-standard"]),
    // For a push, staged-but-uncommitted content is also *not* what is being pushed.
    kind === "push" ? lines(["diff", "--cached", "--name-only"]) : [],
  ]);
  return { unstaged, untracked, staged };
}

/** Repository-relative paths inside the project at `prefix`, made project-relative. */
export function projectPaths(prefix: string, paths: readonly string[]): Set<string> {
  if (!prefix) return new Set(paths);
  const p = `${prefix.replace(/\/$/, "")}/`;
  return new Set(paths.filter((f) => f.startsWith(p)).map((f) => f.slice(p.length)));
}

export interface Isolation {
  /** Project root inside the temporary checkout. */
  root: string;
  note: string;
  /** What the checkout could not isolate (shown with the result, never silently ignored). */
  warnings: string[];
  cleanup(): Promise<void>;
}

/** True when the process that created a temporary checkout has gone (killed, crashed). */
async function ownerGone(tmp: string): Promise<boolean> {
  const pid = Number.parseInt(
    (await readFile(join(tmp, "owner"), "utf8").catch(() => "")).trim(),
    10,
  );
  if (!pid) {
    // Written by an older version (no owner file): only an old checkout counts as abandoned.
    const s = await stat(tmp).catch(() => undefined);
    return !!s && Date.now() - s.mtimeMs > 60 * 60_000;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Unregisters SmartTest's own temporary checkouts whose directory is gone. `git worktree prune`
 * is not used: it would also forget the user's worktrees whose directory is only missing for now
 * (an unmounted drive).
 */
async function forgetOwnCheckouts(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const common = await git(
    repoRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    env,
  ).catch(() => undefined);
  if (common?.code !== 0) return;
  const admin = join(common.stdout.trim(), "worktrees");
  for (const name of await readdir(admin).catch(() => [] as string[])) {
    const gitdir = (await readFile(join(admin, name, "gitdir"), "utf8").catch(() => "")).trim();
    const wt = dirname(gitdir);
    if (basename(wt) !== "repo" || !basename(dirname(wt)).startsWith("smarttest-hook-")) continue;
    if (existsSync(wt)) continue;
    await rm(join(admin, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Removes temporary checkouts left by a hook run that was killed before it could clean up
 * (SIGKILL, power loss). Checkouts of a run that is still alive are kept.
 */
export async function pruneStaleCheckouts(repoRoot: string): Promise<void> {
  const env = cleanGitEnv();
  await forgetOwnCheckouts(repoRoot, env);
  const list = await git(repoRoot, ["worktree", "list", "--porcelain"], env).catch(() => undefined);
  if (list?.code !== 0) return;
  let removed = false;
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    const tmp = dirname(wt);
    if (basename(wt) !== "repo" || !basename(tmp).startsWith("smarttest-hook-")) continue;
    if (!(await ownerGone(tmp))) continue;
    await git(repoRoot, ["worktree", "remove", "--force", wt], env).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    removed = true;
  }
  if (removed) await forgetOwnCheckouts(repoRoot, env);
}

const toSlash = (p: string) => p.replace(/\\/g, "/");

/**
 * Mirrors an installed `node_modules` directory into the checkout. Each entry links to the
 * installed one, except entries that resolve inside the repository (workspace packages, also
 * inside `@scope` and `.bin`): those point at the same path in the checkout, so importing a
 * workspace package loads the content under test, never the working tree's unstaged edits.
 * Returns what could not be isolated, as warnings.
 */
async function linkNodeModules(
  src: string,
  dest: string,
  repoReal: string,
  wt: string,
  ignored: () => Promise<ReadonlySet<string>>,
  projectRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const shown = (entry: string) => toSlash(relative(projectRoot, entry));
  const packages: string[] = [];
  const dirType = process.platform === "win32" ? "junction" : "dir";
  /** Repository-relative path of a resolved entry, unless it is installed content. */
  const inRepo = (real: string): string | undefined => {
    const rel = relative(repoReal, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    // node_modules/.pnpm and hoisted copies are installed packages, not content under test.
    if (rel.split(sep).includes("node_modules")) return undefined;
    return rel;
  };
  const link = async (target: string, to: string, real: string | undefined) => {
    const dir = process.platform === "win32" && !!real && (await stat(real)).isDirectory();
    try {
      await symlink(target, to, dir ? dirType : "file");
    } catch (error) {
      // Windows without symlink rights: a file (a .bin shim) can still be copied.
      if (dir || process.platform !== "win32") throw error;
      await copyFile(target, to);
    }
  };
  const mirror = async (from: string, to: string, top: boolean): Promise<void> => {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    await mapLimit(entries, 32, async (e) => {
      const entry = join(from, e.name);
      // A scope (`@org`) or `.bin` directory holds links of its own.
      if (top && e.isDirectory() && (e.name.startsWith("@") || e.name === ".bin"))
        return mirror(entry, join(to, e.name), false);
      const real = await realpath(entry).catch(() => undefined);
      const rel = real ? inRepo(real) : undefined;
      if (!rel) return link(entry, join(to, e.name), real);
      const checkout = join(wt, rel);
      if (!(await lstat(checkout).catch(() => undefined))) {
        // Not part of the content under test (untracked, or deleted by the change).
        warnings.push(
          `Isolation incomplete: ${shown(entry)} resolves to ${toSlash(rel)}, which is not in the content under test; the working tree's copy was used`,
        );
        return link(entry, join(to, e.name), real);
      }
      packages.push(rel);
      return link(checkout, join(to, e.name), real);
    });
  };
  await mirror(src, dest, true);
  // pnpm's store (node_modules/.pnpm) is linked as a whole. A link from there into the
  // repository (a workspace package as a dependency of an installed package, or hoisted into
  // .pnpm/node_modules) bypasses the checkout. Links are read, not resolved: cheap at thousands
  // of installed packages.
  const store = await realpath(join(src, ".pnpm")).catch(() => undefined);
  if (store) {
    const dirs = [join(store, "node_modules")];
    for (const e of await readdir(store, { withFileTypes: true }).catch(() => []))
      if (e.isDirectory() && e.name !== "node_modules")
        dirs.push(join(store, e.name, "node_modules"));
    const leaks = new Set<string>();
    const scan = async (dir: string, top: boolean): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      await mapLimit(entries, 32, async (e) => {
        const entry = join(dir, e.name);
        if (top && e.isDirectory() && e.name.startsWith("@")) return scan(entry, false);
        if (!e.isSymbolicLink()) return;
        const target = await readlink(entry).catch(() => undefined);
        const rel = target ? inRepo(resolve(dirname(entry), target)) : undefined;
        if (rel) leaks.add(toSlash(rel));
      });
    };
    await mapLimit(dirs, 16, (dir) => scan(dir, true));
    if (leaks.size)
      warnings.push(
        `Isolation incomplete: installed packages in node_modules/.pnpm link to the working tree's ${[...leaks].sort().join(", ")}; unstaged edits there can affect this run`,
      );
  }
  // A linked workspace package's untracked build output (dist/) is not in the checkout. Link it
  // from the working tree so imports resolve, and say it may not match the source under test.
  const built: string[] = [];
  for (const pkg of new Set(packages)) {
    const prefix = `${toSlash(pkg)}/`;
    for (const path of await ignored()) {
      const rest = path.startsWith(prefix) ? path.slice(prefix.length).replace(/\/$/, "") : "";
      if (!rest || rest.includes("/") || rest === "node_modules") continue;
      const to = join(wt, pkg, rest);
      if (await lstat(to).catch(() => undefined)) continue;
      const from = join(repoReal, pkg, rest);
      await link(from, to, await realpath(from).catch(() => undefined));
      built.push(`${prefix}${rest}`);
    }
  }
  if (built.length)
    warnings.push(
      `Linked untracked build output from the working tree (it may not match the content under test): ${built.join(", ")}`,
    );
  return warnings;
}

/**
 * A temporary checkout holding exactly the content under test: the staged tree (`staged`) or
 * HEAD (`push`). Nothing in the user's working tree or index is touched; no stash is used.
 * Binary files, modes, symlinks and renames are preserved by Git itself. The checkout's own
 * index matches its files, so `git diff --cached` there shows the staged change.
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
  await pruneStaleCheckouts(options.repoRoot);
  const tmp = await mkdtemp(join(tmpdir(), "smarttest-hook-"));
  // Lets a later run recognise this checkout as abandoned if this process is killed.
  await writeFile(join(tmp, "owner"), `${process.pid}\n`);
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
      await forgetOwnCheckouts(options.repoRoot, clean);
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const head = (
      await git(options.repoRoot, ["rev-parse", "--verify", "-q", "HEAD"], clean)
    ).stdout.trim();
    if (options.kind === "push" && !head)
      throw new SmartTestError("There is no commit to push yet", {
        code: "ST_HOOK_NO_COMMIT",
        category: "usage",
        hint: "Make the first commit, then run the pre-push hook again.",
      });
    if (head) {
      // The tree under test. For a commit, the hook's index (it may be GIT_INDEX_FILE).
      let tree = "HEAD";
      if (options.kind === "staged") {
        const written = await git(options.repoRoot, ["write-tree"]);
        if (written.code !== 0) throw failure("could not read the staged content", written.stderr);
        tree = written.stdout.trim();
      }
      // --no-checkout: no files are written twice and Git runs no post-checkout hook.
      const add = await git(
        options.repoRoot,
        ["worktree", "add", "--no-checkout", "--detach", "-q", wt, "HEAD"],
        clean,
      );
      if (add.code !== 0) throw failure("could not create a temporary checkout", add.stderr);
      worktree = true;
      const read = await git(wt, ["read-tree", tree], clean);
      if (read.code !== 0) throw failure("could not prepare the temporary checkout", read.stderr);
      // -u records the files' stats, so the checkout's index reports no unstaged change.
      const co = await git(wt, ["checkout-index", "--all", "--force", "-u"], clean);
      if (co.code !== 0) throw failure("could not check out the content under test", co.stderr);
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

    const warnings: string[] = [];
    const repoReal = await realpath(options.repoRoot);
    let ignoredPaths: Promise<Set<string>> | undefined;
    const ignored = () => {
      ignoredPaths ??= git(
        options.repoRoot,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
        clean,
      ).then((r) => new Set(names(r.stdout)));
      return ignoredPaths;
    };
    for (const d of options.nodeModulesDirs) {
      const src = join(options.projectRoot, d, "node_modules");
      const dest = join(root, d, "node_modules");
      if (
        existsSync(src) &&
        !(await lstat(dest).catch(() => undefined)) &&
        existsSync(join(root, d))
      ) {
        warnings.push(
          ...(await linkNodeModules(src, dest, repoReal, wt, ignored, options.projectRoot)),
        );
      }
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
      warnings: [...new Set(warnings)],
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

/** A project directory as written in a config (`./packages/app/`) in its canonical form. */
export function normalizeProject(dir: string): string {
  const p = dir
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  return p === "." ? "" : p;
}

/** The deepest project directory containing a file ("" for the root). */
export function projectOf(file: string, projects: readonly string[]): string {
  let best = "";
  for (const p of projects) if (p && file.startsWith(`${p}/`) && p.length > best.length) best = p;
  return best;
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Checks of this stage naming a project SmartTest does not know: such a check would never run,
 * so it is reported instead of silently dropped.
 */
export function unknownCheckProjects(
  checks: readonly HookCheck[],
  stage: "pre-commit" | "pre-push",
  projects: readonly string[],
): string[] {
  const known = new Set(projects.map(normalizeProject));
  const out: string[] = [];
  for (const c of checks) {
    const s = c.stage ?? "pre-commit";
    if (s !== "both" && s !== stage) continue;
    for (const p of c.projects ?? [])
      if (!known.has(normalizeProject(p)))
        out.push(
          `Check "${c.name}" names project "${p}", which is not a SmartTest project or workspace; it never runs there (known: ${[...known].map((k) => k || '""').join(", ")})`,
        );
  }
  return out;
}

export function planChecks(
  checks: readonly HookCheck[],
  stage: "pre-commit" | "pre-push",
  changed: readonly ChangedFile[],
  projects: readonly string[],
): { name: string; project: string; command: string }[] {
  const dirs = projects.map(normalizeProject);
  const byProject = new Map<string, ChangedFile[]>();
  for (const f of changed) {
    const p = projectOf(f.path, dirs);
    const files = byProject.get(p);
    if (files) files.push(f);
    else byProject.set(p, [f]);
  }
  const out: { name: string; project: string; command: string }[] = [];
  for (const c of checks) {
    const s = c.stage ?? "pre-commit";
    if (s !== "both" && s !== stage) continue;
    const only = c.projects?.map(normalizeProject);
    for (const [project, files] of byProject) {
      if (only && !only.includes(project)) continue;
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
        // `./` keeps a file named like an option (`-rf`, `--fix`) from being read as one.
        command: c.run.replaceAll("{files}", local.map((f) => quote(`./${f}`)).join(" ")),
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
  concurrency = availableParallelism(),
): Promise<CheckResult[]> {
  // Bounded: a monorepo commit can plan one type-check per affected project.
  return mapLimit(planned, concurrency, async (p) => {
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
  });
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
  /** A push that only deleted remote refs: there was no content to test. */
  nothingPushed?: boolean;
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

/** A pre-push that only deletes remote refs sends no content. */
export const onlyDeletions = (refs: readonly PushRef[]) =>
  refs.length > 0 && refs.every((r) => !r.localSha || /^0+$/.test(r.localSha));

/** Number of SmartTest invocations written for a hook stage (duplicate blocks are a finding). */
export function hookInvocations(text: string, stage: "pre-commit" | "pre-push"): number {
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
  const inStage =
    stage === "pre-commit"
      ? lines.filter((l) => /smarttest\s+run\b[^\n]*--staged/.test(l))
      : lines.filter((l) => /smarttest\s+run\b[^\n]*--push/.test(l));
  return inStage.length;
}
