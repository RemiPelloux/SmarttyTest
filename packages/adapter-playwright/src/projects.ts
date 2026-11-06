/**
 * Playwright projects as the config resolves them: each project's `baseURL`, its dependencies
 * (setup projects), `testDir`, `testMatch` and `testIgnore`, the `webServer` URLs, and the projects
 * each spec file belongs to. Read through `playwright test --list` with a small reporter, so the
 * values are Playwright's own (environment variables applied, defaults filled in), never guessed.
 *
 * A spec is **live** when every project that runs it targets a remote environment: an `https://`
 * `baseURL` that is not the loopback interface and not a `webServer` the config starts, or a
 * dependency (a setup project) that does. Live specs are not run unless asked (`--live`).
 */

export interface PlaywrightProject {
  name: string;
  /** `use.baseURL` as resolved for this project (undefined when not set). */
  baseURL?: string;
  /** Projects that run first (setup projects). */
  dependencies: string[];
  testDir?: string;
  /** `testMatch` / `testIgnore`, as strings (a regular expression as `/source/flags`). */
  testMatch: string[];
  testIgnore: string[];
}

export interface PlaywrightProjects {
  projects: PlaywrightProject[];
  /** URLs of the `webServer` entries the config starts (`url`, or `http://localhost:<port>`). */
  webServers: string[];
  /** Spec file (project-relative, `/`) → the projects that list it. */
  files: Record<string, string[]>;
}

export interface LiveSpec {
  file: string;
  /** The projects that would run it, all live. */
  projects: string[];
  /** The remote `baseURL` they target (the first one, when several). */
  baseURL: string;
}

/** The environment variable the reporter writes its JSON to. */
export const PROJECTS_OUTPUT_ENV = "SMARTTEST_PLAYWRIGHT_PROJECTS";

/**
 * The reporter `playwright test --list` loads (CommonJS, no dependency). It writes the resolved
 * projects and the projects of each listed test file, then nothing else.
 */
export const PROJECTS_REPORTER = `"use strict";
const fs = require("node:fs");
const str = (v) => (v instanceof RegExp ? String(v) : typeof v === "string" ? v : undefined);
const list = (v) =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(str).filter((x) => x !== undefined);
class SmartTestProjectsReporter {
  onBegin(config, suite) {
    const projects = config.projects.map((p) => ({
      name: p.name,
      baseURL: p.use && typeof p.use.baseURL === "string" ? p.use.baseURL : undefined,
      dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
      testDir: p.testDir,
      testMatch: list(p.testMatch),
      testIgnore: list(p.testIgnore),
    }));
    const ws = config.webServer ? (Array.isArray(config.webServer) ? config.webServer : [config.webServer]) : [];
    const webServers = ws
      .map((w) => (w && typeof w.url === "string" ? w.url : w && w.port ? "http://localhost:" + w.port : undefined))
      .filter(Boolean);
    const files = {};
    for (const t of suite.allTests()) {
      const project = t.parent.project();
      const name = project ? project.name : "";
      (files[t.location.file] = files[t.location.file] || []).includes(name) || files[t.location.file].push(name);
    }
    fs.writeFileSync(process.env.${PROJECTS_OUTPUT_ENV}, JSON.stringify({ projects, webServers, files }));
  }
  printsToStdio() {
    return false;
  }
}
module.exports = SmartTestProjectsReporter;
`;

const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/**
 * True when `baseURL` targets a remote environment: `https://` on a host that is not the loopback
 * interface, and not the origin of a `webServer` the config starts. Anything else (no baseURL, an
 * `http://` URL, a value that is not a URL) is local: when in doubt the spec runs.
 */
export function isRemoteBaseURL(baseURL: string | undefined, webServers: readonly string[] = []) {
  if (!baseURL) return false;
  const url = parse(baseURL);
  if (url?.protocol !== "https:" || LOOPBACK.test(url.hostname)) return false;
  return !webServers.some((w) => parse(w)?.origin === url.origin);
}

/**
 * The live projects, each with the remote baseURL it reaches: its own, or that of a project it
 * depends on (a setup project that logs in to the deployed environment makes its dependents live).
 */
export function liveProjects(info: PlaywrightProjects): Map<string, string> {
  const byName = new Map(info.projects.map((p) => [p.name, p]));
  const memo = new Map<string, string | null>();
  const visit = (name: string, seen: Set<string>): string | null => {
    if (memo.has(name)) return memo.get(name) as string | null;
    const p = byName.get(name);
    if (!p || seen.has(name)) return null;
    seen.add(name);
    let remote: string | null = isRemoteBaseURL(p.baseURL, info.webServers)
      ? (p.baseURL as string)
      : null;
    for (const d of p.dependencies) remote ??= visit(d, seen);
    memo.set(name, remote);
    return remote;
  };
  const out = new Map<string, string>();
  for (const p of info.projects) {
    const remote = visit(p.name, new Set());
    if (remote) out.set(p.name, remote);
  }
  return out;
}

/** Spec files every one of whose projects is live. A file in one local project is not live. */
export function liveSpecs(info: PlaywrightProjects): LiveSpec[] {
  const live = liveProjects(info);
  const out: LiveSpec[] = [];
  for (const [file, projects] of Object.entries(info.files)) {
    if (!projects.length || !projects.every((p) => live.has(p))) continue;
    out.push({
      file,
      projects: [...projects].sort(),
      baseURL: live.get(projects[0] as string) as string,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
