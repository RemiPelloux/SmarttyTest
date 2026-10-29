/**
 * Computes the data behind the site's live impact demo: the real SmartTest selection for every
 * combination of four edits to the nest-auth-vitest fixture. Run after changing the analyzer:
 *   npx tsc -b && node scripts/site/demo-data.mjs
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SmartTest } from "@smarttest/core";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE = join(ROOT, "fixtures/projects/nest-auth-vitest");

export const EDITS = [
  {
    id: "verify",
    label: "TokenManager.verify",
    file: "src/modules/auth/TokenManager.ts",
    find: "token.length > 8",
    replace: "token.length > 7",
  },
  {
    id: "issue",
    label: "TokenManager.issue",
    file: "src/modules/auth/TokenManager.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text being edited
    find: "_${userId.length}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text being edited
    replace: "_${userId.trim().length}",
  },
  {
    id: "isEmail",
    label: "isEmail",
    file: "src/shared/validators/EmailValidator.ts",
    find: "[^@\\s]+$",
    replace: "[^@\\s]{2,}$",
  },
  {
    id: "total",
    label: "CatalogService.total",
    file: "src/modules/catalog/CatalogService.ts",
    find: "sum + p.price",
    replace: "sum + p.price * 1",
  },
];

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=site", "-c", "user.email=site@local", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      stdio: "pipe",
    },
  );

const dir = await mkdtemp(join(tmpdir(), "st-site-demo-"));
await cp(FIXTURE, dir, {
  recursive: true,
  filter: (p) => !p.includes("node_modules") && !p.includes(".smarttest"),
});
await symlink(join(FIXTURE, "node_modules"), join(dir, "node_modules"), "dir");
await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
git(dir, "init", "-q", "-b", "main");
git(dir, "add", "-A");
git(dir, "commit", "-q", "-m", "initial");

const originals = new Map();
for (const e of EDITS) originals.set(e.file, await readFile(join(dir, e.file), "utf8"));

const combos = {};
let tests = [];
for (let mask = 1; mask < 1 << EDITS.length; mask++) {
  const chosen = EDITS.filter((_, i) => mask & (1 << i));
  const contents = new Map(originals);
  for (const e of chosen) {
    const before = contents.get(e.file);
    if (!before.includes(e.find)) throw new Error(`anchor not found: ${e.find}`);
    contents.set(e.file, before.replace(e.find, e.replace));
  }
  for (const [f, c] of contents) await writeFile(join(dir, f), c);
  const a = await (await SmartTest.open({ root: dir })).analyze();
  tests = a.testFiles;
  combos[chosen.map((e) => e.id).join("+")] = {
    selected: a.decision.selectedTests.map((t) => ({
      file: t.filePath,
      reason: t.reasons[0]?.message ?? "",
      path: t.reasons[0]?.path ?? [],
    })),
    ms: Math.round(Object.values(a.timings).reduce((x, y) => x + y, 0)),
  };
}
const out = { fixture: "fixtures/projects/nest-auth-vitest", edits: EDITS, tests, combos };
await writeFile(join(ROOT, "site/assets/demo-data.json"), `${JSON.stringify(out, null, 1)}\n`);
await rm(dir, { recursive: true, force: true });
console.log(`demo data: ${Object.keys(combos).length} combinations, ${tests.length} test files`);
