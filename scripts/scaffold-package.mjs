#!/usr/bin/env node
/**
 * Package scaffolder for the SmartTest monorepo.
 *
 *   node scripts/scaffold-package.mjs --all          # (re)scaffold every package in the manifest
 *   node scripts/scaffold-package.mjs impact-engine  # scaffold a single manifest entry
 *
 * Non-destructive by design (same rule the product follows):
 *   - package.json / tsconfig.json are regenerated (they are derived from the manifest)
 *   - README.md and src/** are only created when missing — never overwritten
 *   - the root tsconfig.json project references are regenerated
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(repoRoot, "scripts/packages.manifest.json"), "utf8"),
);
const byName = new Map(manifest.packages.map((p) => [p.name, p]));

const args = process.argv.slice(2);
const targets = args.includes("--all") ? manifest.packages : args.map((n) => byName.get(n));
if (targets.length === 0 || targets.some((t) => !t)) {
  console.error(
    "Usage: scaffold-package.mjs --all | <name...>  (name must exist in scripts/packages.manifest.json)",
  );
  process.exit(2);
}

const publishName = (p) => p.publishName ?? `${manifest.scope}/${p.name}`;
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

async function writeIfMissing(path, content) {
  if (existsSync(path)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}

function assertAcyclic() {
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "active")
      throw new Error(`Package dependency cycle: ${[...trail, name].join(" -> ")}`);
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`Unknown dependency "${name}" (from ${trail.at(-1)})`);
    state.set(name, "active");
    for (const d of pkg.deps ?? []) visit(d, [...trail, name]);
    state.set(name, "done");
  };
  for (const p of manifest.packages) visit(p.name, []);
}

assertAcyclic();

for (const pkg of targets) {
  const dir = join(repoRoot, "packages", pkg.name);
  const deps = pkg.deps ?? [];

  const packageJson = {
    name: publishName(pkg),
    version: manifest.version ?? "0.0.0",
    description: pkg.description,
    license: "Apache-2.0",
    type: "module",
    private: pkg.name !== "cli",
    ...(pkg.bin ? { bin: { [pkg.bin]: "./dist/bin.js" } } : {}),
    exports: {
      ".": {
        "@smarttest/source": "./src/index.ts",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    files: ["dist"],
    engines: { node: ">=22.12.0" },
    scripts: { build: "tsc -b", typecheck: "tsc -b --noEmit false" },
    dependencies: {
      ...Object.fromEntries(deps.map((d) => [publishName(byName.get(d)), "workspace:*"])),
      ...(pkg.external ?? {}),
    },
    smarttest: { epic: pkg.epic, release: "1.0.0" },
  };
  if (Object.keys(packageJson.dependencies).length === 0) delete packageJson.dependencies;
  if (pkg.devDeps?.length) {
    packageJson.devDependencies = Object.fromEntries(
      pkg.devDeps.map((d) => [publishName(byName.get(d)), "workspace:*"]),
    );
  }

  const tsconfig = {
    extends: "../../tsconfig.base.json",
    compilerOptions: { rootDir: "src", outDir: "dist" },
    include: ["src"],
    exclude: ["src/**/*.test.ts"],
    references: deps.map((d) => ({ path: `../${d}` })),
  };

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), json(packageJson));
  await writeFile(join(dir, "tsconfig.json"), json(tsconfig));

  await writeIfMissing(
    join(dir, "src/index.ts"),
    `/**
 * ${publishName(pkg)} — ${pkg.description}
 *
 * Epic: ${pkg.epic} · Target release: 1.0.0
 * See documentation/planning/release-1.0.0/epics/ for the user stories that fill this package.
 */
export const packageInfo = {
  name: ${JSON.stringify(publishName(pkg))},
  epic: ${JSON.stringify(pkg.epic)},
  status: "scaffold",
} as const;
`,
  );

  if (pkg.bin) {
    await writeIfMissing(
      join(dir, "src/bin.ts"),
      `#!/usr/bin/env node
import { packageInfo } from "./index.js";

// Placeholder entry point. The command framework lands in story ST-085.
console.log(\`\${packageInfo.name} — pre-release scaffold. See https://github.com/RemiPelloux/SmarttyTest\`);
`,
    );
  }

  await writeIfMissing(
    join(dir, "README.md"),
    `# ${publishName(pkg)}

> ${pkg.description}

| | |
|---|---|
| Epic | \`${pkg.epic}\` — see [planning](../../documentation/planning/release-1.0.0/epics/README.md) |
| Target release | 1.0.0 |
| Status | Scaffold |
| Workspace deps | ${deps.length ? deps.map((d) => `\`${publishName(byName.get(d))}\``).join(", ") : "—"} |

Architecture context: [documentation/architecture/overview.md](../../documentation/architecture/overview.md)
`,
  );

  console.log(`✔ packages/${pkg.name}`);
}

// Root solution-style tsconfig with project references (ordered as in the manifest).
await writeFile(
  join(repoRoot, "tsconfig.json"),
  json({ files: [], references: manifest.packages.map((p) => ({ path: `packages/${p.name}` })) }),
);
console.log("✔ tsconfig.json references updated");

// Normalise formatting so re-running the scaffolder is a no-op for `pnpm lint`.
const biome = join(repoRoot, "node_modules/.bin/biome");
if (existsSync(biome)) {
  const paths = [...targets.map((p) => join("packages", p.name)), "tsconfig.json"];
  execFileSync(biome, ["format", "--write", ...paths], { cwd: repoRoot, stdio: "ignore" });
}
