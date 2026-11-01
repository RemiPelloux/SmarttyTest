/**
 * Shared by the Studio accessibility checks (audit.mjs, safari.mjs, screen-reader.mjs): the
 * screens, the WCAG tags, and a Studio server on a throwaway git copy of
 * fixtures/projects/ts-lib-vitest with one change that a selected test catches.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE = join(ROOT, "fixtures/projects/ts-lib-vitest");
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const SCREENS = [
  { id: "overview", path: "/overview", title: "Overview" },
  { id: "impact", path: "/impact", title: "Impact" },
  { id: "tests", path: "/tests", title: "Tests" },
  { id: "trust", path: "/trust", title: "Trust" },
  { id: "source", path: "/source", title: "Source" },
];

function vcs(cwd, ...rest) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=SmartTest",
      "-c",
      "user.email=ci@smarttest.dev",
      "-c",
      "commit.gpgsign=false",
      ...rest,
    ],
    { cwd, stdio: "pipe" },
  );
}

export async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "st-studio-a11y-"));
  await cp(FIXTURE, dir, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes(".smarttest"),
  });
  // Windows: pnpm's relative package links break behind one junction (see linkNodeModules).
  const { linkNodeModules } = await import(
    pathToFileURL(join(ROOT, "packages/shared/dist/index.js")).href
  );
  await linkNodeModules(join(FIXTURE, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
  vcs(dir, "init", "-q", "-b", "main");
  vcs(dir, "add", "-A");
  vcs(dir, "commit", "-q", "-m", "initial");
  // One real change that a selected test catches, so the run drawer shows a failure.
  const file = join(dir, "src/util/strings.ts");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace("s.charAt(0).toUpperCase()", "s.charAt(0)"));
  return dir;
}

export function buildStudio() {
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules/typescript/bin/tsc"), "-b", "packages/studio/tsconfig.json"],
    { cwd: ROOT, stdio: "inherit" },
  );
}

/**
 * Builds Studio, starts it on a fresh fixture and returns `{ handle, fixture, origin, url, close }`.
 * `url(path, query)` adds the session token, so the page opens paired.
 */
export async function startStudioOnFixture({ assets, build = true } = {}) {
  if (build) buildStudio();
  const { startStudio } = await import(
    pathToFileURL(join(ROOT, "packages/studio/dist/index.js")).href
  );
  const fixture = await makeFixture();
  const handle = await startStudio({
    root: fixture,
    port: 0,
    watch: false,
    storeDir: join(fixture, ".smarttest"),
    ...(assets ? { assetDir: resolve(assets) } : {}),
  });
  const origin = `http://127.0.0.1:${handle.port}`;
  let visits = 0;
  return {
    handle,
    fixture,
    origin,
    url(path, { theme, token = true } = {}) {
      visits += 1;
      const query = new URLSearchParams({ ...(theme ? { theme } : {}), v: String(visits) });
      return `${origin}${path}?${query}${token ? `#token=${handle.token}` : ""}`;
    },
    async close() {
      await handle.close();
      await rm(fixture, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
