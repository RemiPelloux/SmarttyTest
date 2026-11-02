/**
 * Angular CLI workspaces: the projects of an `angular.json` and what their `test` target reads.
 * Pure parsing, no file access; paths stay as the workspace writes them (relative to the
 * workspace directory).
 */

export type AngularTestRunner = "vitest" | "karma" | "jest";

/** Builders that run unit tests through `ng test`. */
export const ANGULAR_TEST_BUILDERS: Record<string, AngularTestRunner> = {
  "@angular/build:unit-test": "vitest",
  "@angular-builders/jest:run": "jest",
  "@angular/build:karma": "karma",
  "@angular-devkit/build-angular:karma": "karma",
};

export interface AngularTestTarget {
  project: string;
  /** Project root, relative to the workspace ("" for the default project). */
  root: string;
  /** Source root, relative to the workspace (`<root>/src` when unset). */
  sourceRoot: string;
  builder: string;
  /** The runner the builder starts (the unit-test builder's `runner` option; Karma builders: karma). */
  runner: AngularTestRunner;
  /** Whether the build type-checks every file a spec imports (the unit-test and Karma builders). */
  typeChecks: boolean;
  /** Globs relative to the source root. */
  include: string[];
  exclude: string[];
  /**
   * Files the runner loads for every test: setup files, providers file, polyfills, global styles
   * and scripts, the TypeScript and runner configs, Karma's config. Relative to the workspace.
   */
  loads: { file: string; key: string }[];
  /** Option values that are not plain paths (reported, never guessed). */
  computed: string[];
}

interface Target {
  builder?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
}

const DEFAULT_INCLUDE = ["**/*.spec.ts", "**/*.test.ts"];

const strings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap((x) =>
          typeof x === "string"
            ? [x]
            : x && typeof x === "object" && typeof (x as { input?: unknown }).input === "string"
              ? [(x as { input: string }).input]
              : [],
        )
      : [];

const join = (...parts: string[]) =>
  parts
    .filter((p) => p !== "" && p !== ".")
    .join("/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "");

/**
 * The `test` targets of an Angular workspace (`angular.json`, or one Nx `project.json` passed with
 * `projectName`). Returns [] for text that is not a workspace.
 */
export function angularTestTargets(text: string, projectName?: string): AngularTestTarget[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const projects: Record<string, Record<string, unknown>> = projectName !== undefined
    ? { [projectName]: json }
    : ((json.projects as Record<string, Record<string, unknown>> | undefined) ?? {});
  const out: AngularTestTarget[] = [];
  for (const [name, project] of Object.entries(projects)) {
    if (!project || typeof project !== "object") continue;
    const targets = (project.architect ?? project.targets) as Record<string, Target> | undefined;
    const test = targets?.test;
    const builder = test?.builder ?? (test as { executor?: string } | undefined)?.executor;
    if (!builder || !(builder in ANGULAR_TEST_BUILDERS)) continue;
    const root = typeof project.root === "string" ? project.root : "";
    const sourceRoot =
      typeof project.sourceRoot === "string" ? project.sourceRoot : join(root, "src");
    const options = test?.options ?? {};
    const runner =
      builder === "@angular/build:unit-test"
        ? options.runner === "karma"
          ? "karma"
          : "vitest"
        : (ANGULAR_TEST_BUILDERS[builder] as AngularTestRunner);
    const loads: AngularTestTarget["loads"] = [];
    const computed: string[] = [];
    const add = (key: string, value: unknown) => {
      for (const file of strings(value)) loads.push({ file: join(file), key });
    };
    // The unit-test builder builds the tests with the build target's options.
    const buildRef =
      typeof options.buildTarget === "string" ? options.buildTarget : `${name}:build`;
    const [buildProject, buildName = "build"] = buildRef.split(":");
    const buildTarget =
      buildProject === name
        ? targets?.[buildName]
        : (
            (projects[buildProject as string]?.architect ??
              projects[buildProject as string]?.targets) as Record<string, Target> | undefined
          )?.[buildName];
    const buildOptions = builder === "@angular/build:unit-test" ? (buildTarget?.options ?? {}) : {};
    for (const [key, value] of Object.entries({ ...buildOptions, ...options })) {
      if (
        [
          "setupFiles",
          "providersFile",
          "polyfills",
          "styles",
          "scripts",
          "tsConfig",
          "karmaConfig",
          "main",
          "setupFilesAfterEnv",
        ].includes(key)
      )
        add(key, value);
      else if (key === "config" && runner === "jest" && typeof value === "string") add(key, value);
      else if (key === "runnerConfig") {
        if (typeof value === "string") add(key, value);
        else if (value === true) computed.push("runnerConfig: true (default file search)");
      }
    }
    // The builders' defaults: tsconfig.spec.json in the project root; Jest's jest.config.js.
    if (!("tsConfig" in options) && builder !== "@angular-devkit/build-angular:karma")
      loads.push({ file: join(root, "tsconfig.spec.json"), key: "tsConfig" });
    if (runner === "jest" && !("config" in options))
      loads.push({ file: join(root, "jest.config.js"), key: "config" });
    out.push({
      project: name,
      root,
      sourceRoot,
      builder,
      runner,
      typeChecks: runner !== "jest",
      include: strings(options.include).length ? strings(options.include) : DEFAULT_INCLUDE,
      exclude: strings(options.exclude),
      // Polyfills given as package names (`zone.js`, `zone.js/testing`) are not project files.
      loads: loads.filter(
        (l) => l.key !== "polyfills" || /\.[cm]?tsx?$/.test(l.file) || /^\.\.?\//.test(l.file),
      ),
      computed,
    });
  }
  return out;
}
