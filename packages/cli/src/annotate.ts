/**
 * CI annotations for `run`, `ci` and `impact`: on when GitHub Actions, GitLab CI or Bitbucket
 * Pipelines is detected (or forced with `--annotations <provider>`), off with `--no-annotations`
 * or `reports.annotations: false`. Output formats only, never a CI API call (ADR-0004).
 */
import { isAbsolute, join, relative } from "node:path";
import type {
  AnnotationInput,
  AnnotationProvider,
  CiAnnotations,
  SmartTest,
} from "@smarttest/core";
import { SmartTestError, writeFileAtomic } from "@smarttest/shared";
import type { Flags } from "./args.js";

const PROVIDERS: readonly AnnotationProvider[] = ["github", "gitlab", "bitbucket"];

/** Where each provider checks the repository out: annotation paths are relative to it. */
const WORKSPACE: Record<AnnotationProvider, string> = {
  github: "GITHUB_WORKSPACE",
  gitlab: "CI_PROJECT_DIR",
  bitbucket: "BITBUCKET_CLONE_DIR",
};

/** The provider to annotate for, or undefined when annotations are off for this run. */
export function annotationProvider(
  flags: Flags,
  enabledInConfig: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AnnotationProvider | undefined {
  if (flags["no-annotations"]) return undefined;
  if (flags.annotations !== undefined) {
    if (!PROVIDERS.includes(flags.annotations as AnnotationProvider))
      throw new SmartTestError("--annotations must be github, gitlab or bitbucket", {
        code: "ST_USAGE",
        category: "usage",
      });
    return flags.annotations as AnnotationProvider;
  }
  if (!enabledInConfig) return undefined;
  if (env.GITHUB_ACTIONS === "true") return "github";
  if (env.GITLAB_CI) return "gitlab";
  if (env.BITBUCKET_BUILD_NUMBER) return "bitbucket";
  return undefined;
}

/** "apps/web/" when the project is a subdirectory of the checked-out repository, else "". */
export function pathPrefix(
  provider: AnnotationProvider,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ws = env[WORKSPACE[provider]];
  if (!ws) return "";
  const rel = relative(ws, root).split("\\").join("/");
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? "" : `${rel}/`;
}

/**
 * Prints the job-log part (stdout, or stderr when stdout carries a `--json` document: the CI
 * reads workflow commands from both), writes the report files, and appends the step summary when
 * `summary` is true. Returns what was emitted.
 */
export async function emitAnnotations(options: {
  st: SmartTest;
  provider: AnnotationProvider;
  input: Omit<AnnotationInput, "pathPrefix">;
  write: (line: string) => void;
  summary: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ annotations: CiAnnotations; files: string[] }> {
  const env = options.env ?? process.env;
  const { ciAnnotations } = await import("@smarttest/core");
  const annotations = ciAnnotations(options.provider, {
    ...options.input,
    pathPrefix: pathPrefix(options.provider, options.st.root, env),
  });
  for (const l of annotations.log) options.write(l);
  const dir = isAbsolute(options.st.config.reports.outputDir)
    ? options.st.config.reports.outputDir
    : join(options.st.root, options.st.config.reports.outputDir);
  const files: string[] = [];
  for (const [name, content] of Object.entries(annotations.files)) {
    const path = join(dir, name);
    await writeFileAtomic(path, content);
    files.push(path);
  }
  if (options.summary && options.provider === "github" && env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(env.GITHUB_STEP_SUMMARY, annotations.summary);
  }
  return { annotations, files };
}
