/**
 * `smarttest ci`: works out the CI provider, whether this is a merge/pull request, which ref to
 * compare against, and makes sure the clone has enough history to find the merge-base.
 */
import { runProcess } from "@smarttest/shared";

export interface CiContext {
  provider:
    | "github"
    | "gitlab"
    | "jenkins"
    | "circleci"
    | "azure"
    | "bitbucket"
    | "generic"
    | "none";
  /** Branch the change will be merged into, for merge/pull requests. */
  targetBranch?: string;
  /** The default branch, when the CI exposes it. */
  defaultBranch?: string;
  /** Branch being built. */
  branch?: string;
  /** Exact revision to compare against when the CI gives one (e.g. the previous successful build). */
  baseSha?: string;
  isPullRequest: boolean;
  /** Markdown summary destination, when the provider has one (GitHub step summary). */
  summaryFile?: string;
  evidence: string;
}

const strip = (b: string | undefined) => b?.replace(/^refs\/heads\//, "").trim() || undefined;

export function detectCi(env: NodeJS.ProcessEnv = process.env): CiContext {
  if (env.GITHUB_ACTIONS === "true") {
    const pr = !!env.GITHUB_BASE_REF;
    return {
      provider: "github",
      isPullRequest: pr,
      ...(pr ? { targetBranch: env.GITHUB_BASE_REF as string } : {}),
      ...(env.GITHUB_REF_NAME ? { branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME } : {}),
      ...(env.GITHUB_EVENT_BEFORE ? { baseSha: env.GITHUB_EVENT_BEFORE } : {}),
      ...(env.GITHUB_STEP_SUMMARY ? { summaryFile: env.GITHUB_STEP_SUMMARY } : {}),
      evidence: "GITHUB_ACTIONS",
    };
  }
  if (env.GITLAB_CI) {
    const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
    return {
      provider: "gitlab",
      isPullRequest: !!target,
      ...(target ? { targetBranch: target } : {}),
      ...(env.CI_DEFAULT_BRANCH ? { defaultBranch: env.CI_DEFAULT_BRANCH } : {}),
      ...(env.CI_COMMIT_BRANCH || env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
        ? { branch: (env.CI_COMMIT_BRANCH || env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME) as string }
        : {}),
      ...(env.CI_COMMIT_BEFORE_SHA && !/^0+$/.test(env.CI_COMMIT_BEFORE_SHA)
        ? { baseSha: env.CI_COMMIT_BEFORE_SHA }
        : {}),
      evidence: "GITLAB_CI",
    };
  }
  if (env.JENKINS_URL) {
    const target = env.CHANGE_TARGET;
    return {
      provider: "jenkins",
      isPullRequest: !!target,
      ...(target ? { targetBranch: target } : {}),
      ...(env.BRANCH_NAME || env.GIT_BRANCH
        ? { branch: strip(env.BRANCH_NAME || env.GIT_BRANCH)?.replace(/^origin\//, "") as string }
        : {}),
      ...(env.GIT_PREVIOUS_SUCCESSFUL_COMMIT
        ? { baseSha: env.GIT_PREVIOUS_SUCCESSFUL_COMMIT }
        : {}),
      evidence: "JENKINS_URL",
    };
  }
  if (env.CIRCLECI) {
    return {
      provider: "circleci",
      isPullRequest: !!(env.CIRCLE_PULL_REQUEST || env.CIRCLE_PULL_REQUESTS),
      ...(env.CIRCLE_BRANCH ? { branch: env.CIRCLE_BRANCH } : {}),
      evidence: "CIRCLECI",
    };
  }
  if (env.TF_BUILD) {
    const target = strip(env.SYSTEM_PULLREQUEST_TARGETBRANCH);
    return {
      provider: "azure",
      isPullRequest: !!target,
      ...(target ? { targetBranch: target } : {}),
      ...(env.BUILD_SOURCEBRANCH ? { branch: strip(env.BUILD_SOURCEBRANCH) as string } : {}),
      evidence: "TF_BUILD",
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const target = env.BITBUCKET_PR_DESTINATION_BRANCH;
    return {
      provider: "bitbucket",
      isPullRequest: !!target,
      ...(target ? { targetBranch: target } : {}),
      ...(env.BITBUCKET_BRANCH ? { branch: env.BITBUCKET_BRANCH } : {}),
      evidence: "BITBUCKET_BUILD_NUMBER",
    };
  }
  if (env.CI && env.CI !== "false")
    return { provider: "generic", isPullRequest: false, evidence: "CI" };
  return { provider: "none", isPullRequest: false, evidence: "no CI variables" };
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await runProcess("git", args, { cwd });
  return { ok: r.code === 0, out: r.stdout.trim() };
}

export interface CiPlan {
  ci: CiContext;
  /** What the run compares against: a ref (merge-base comparison) or everything. */
  base?: string;
  /** Compare directly with `base` (a revision), not with the merge-base. */
  direct?: boolean;
  all: boolean;
  steps: string[];
  warnings: string[];
}

/**
 * Chooses what to compare against and fetches history until it is available:
 * merge/pull request → merge-base with origin/<target>; branch build with a known previous
 * revision → that revision; otherwise → the parent commit; no history at all → the full suite.
 */
export async function prepareCi(
  root: string,
  ci: CiContext,
  options: { maxDeepen?: number } = {},
): Promise<CiPlan> {
  const steps: string[] = [];
  const warnings: string[] = [];
  const shallow = (await git(root, ["rev-parse", "--is-shallow-repository"])).out === "true";
  if (shallow) steps.push("shallow clone detected");
  if (ci.targetBranch) {
    const ref = `origin/${ci.targetBranch}`;
    if (!(await git(root, ["rev-parse", "--verify", "--quiet", ref])).ok) {
      const f = await git(root, [
        "fetch",
        "--no-tags",
        "--depth=50",
        "origin",
        `+refs/heads/${ci.targetBranch}:refs/remotes/${ref}`,
      ]);
      steps.push(f.ok ? `fetched ${ref}` : `could not fetch ${ref}`);
    }
    for (let i = 0, depth = 50; i < (options.maxDeepen ?? 6); i++, depth *= 2) {
      if ((await git(root, ["merge-base", "HEAD", ref])).ok)
        return { ci, base: ref, all: false, steps, warnings };
      if (!(await git(root, ["rev-parse", "--is-shallow-repository"])).out.startsWith("true"))
        break;
      const d = await git(root, [
        "fetch",
        "--no-tags",
        `--deepen=${depth}`,
        "origin",
        ci.targetBranch,
      ]);
      steps.push(d.ok ? `deepened history by ${depth}` : "could not deepen history");
      if (!d.ok) break;
    }
    if (!(await git(root, ["merge-base", "HEAD", ref])).ok && shallow) {
      const u = await git(root, ["fetch", "--no-tags", "--unshallow", "origin"]);
      steps.push(u.ok ? "fetched full history" : "could not fetch full history");
    }
    if ((await git(root, ["merge-base", "HEAD", ref])).ok)
      return { ci, base: ref, all: false, steps, warnings };
    warnings.push(`no merge-base with ${ref}; running the full suite`);
    return { ci, all: true, steps, warnings };
  }
  if (ci.baseSha) {
    if (!(await git(root, ["cat-file", "-e", `${ci.baseSha}^{commit}`])).ok) {
      const f = await git(root, ["fetch", "--no-tags", "--depth=50", "origin", ci.baseSha]);
      steps.push(
        f.ok ? `fetched ${ci.baseSha.slice(0, 12)}` : `could not fetch ${ci.baseSha.slice(0, 12)}`,
      );
    }
    if ((await git(root, ["cat-file", "-e", `${ci.baseSha}^{commit}`])).ok)
      return { ci, base: ci.baseSha, direct: true, all: false, steps, warnings };
    warnings.push(`previous revision ${ci.baseSha.slice(0, 12)} is not available`);
  }
  if (!(await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^"])).ok && shallow) {
    const d = await git(root, ["fetch", "--no-tags", "--deepen=1", "origin"]);
    steps.push(d.ok ? "deepened history by 1" : "could not deepen history");
  }
  if ((await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^"])).ok)
    return { ci, base: "HEAD^", direct: true, all: false, steps, warnings };
  warnings.push("no parent commit available; running the full suite");
  return { ci, all: true, steps, warnings };
}
