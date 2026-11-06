/**
 * CI annotations through the CLI: detected from the environment, bounded, printed beside a
 * `--json` document without breaking it, and turned off by a flag or the config.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "smarttest";
import { afterEach, describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

async function cli(cwd: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (out += s), isTTY: false },
      stderr: { write: (s: string) => (err += s), isTTY: false },
    },
    cwd,
  );
  return { code, out, err };
}

const SET = [
  "GITHUB_ACTIONS",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_WORKSPACE",
  "GITLAB_CI",
  "BITBUCKET_BUILD_NUMBER",
];
afterEach(() => {
  for (const k of SET) delete process.env[k];
});

async function changed() {
  const dir = await materialize("nest-auth-vitest", { git: true });
  await edit(dir, "src/modules/catalog/CatalogService.ts", "sum + p.price", "p.price + sum");
  return dir;
}

describe("CI annotations", () => {
  it("annotates the selection on GitHub Actions and appends the step summary", async () => {
    const dir = await changed();
    const summary = join(dir, "..", `summary-${Date.now()}.md`);
    await writeFile(summary, "");
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_STEP_SUMMARY = summary;
    process.env.GITHUB_WORKSPACE = join(dir, "..");
    const r = await cli(dir, "impact");
    expect(r.code).toBe(0);
    const notices = r.out.split("\n").filter((l) => l.startsWith("::notice"));
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.length).toBeLessThanOrEqual(10);
    // Paths are relative to the checked-out repository, here the project's parent directory.
    const project = dir.split(/[\\/]/).at(-1);
    expect(notices.some((l) => l.includes(`file=${project}/tests/`))).toBe(true);
    expect(notices.some((l) => l.includes("not run (skipped by selection)"))).toBe(true);
    const md = await readFile(summary, "utf8");
    expect(md).toContain("selection only, no test ran in this step");
    expect(md).toContain("**Time saved:**");

    // With --json, stdout is exactly the document; the annotations go to stderr.
    const json = await cli(dir, "impact", "--json");
    expect(JSON.parse(json.out).command).toBe("impact");
    expect(json.err).toContain("::notice");

    expect((await cli(dir, "impact", "--no-annotations")).out).not.toContain("::notice");
  }, 120_000);

  it("is off when the config says so, and writes GitLab's Code Quality report", async () => {
    const dir = await changed();
    process.env.GITLAB_CI = "true";
    const r = await cli(dir, "impact");
    expect(r.out).toContain("section_start:");
    const report = JSON.parse(
      await readFile(join(dir, ".smarttest/reports/gl-code-quality.json"), "utf8"),
    );
    expect(report.length).toBeGreaterThan(0);
    expect(report[0].check_name).toBe("smarttest-selected");

    await writeFile(
      join(dir, "smarttest.config.json"),
      JSON.stringify({ reports: { annotations: false } }),
    );
    expect((await cli(dir, "impact")).out).not.toContain("section_start:");
    // Forced for one run, whatever the config and the environment say.
    const forced = await cli(dir, "impact", "--annotations", "bitbucket");
    expect(forced.code).toBe(0);
    const insights = JSON.parse(
      await readFile(join(dir, ".smarttest/reports/bitbucket-insights.json"), "utf8"),
    );
    expect(insights.report.report_type).toBe("TEST");
    expect((await cli(dir, "impact", "--annotations", "jenkins")).code).toBe(2);
  }, 120_000);
});
