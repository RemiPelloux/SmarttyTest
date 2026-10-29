import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const FIXTURES = resolve(import.meta.dirname, "../fixtures/projects");

/** Copies a fixture into a temp dir (without node_modules) and links its installed dependencies. */
export async function materialize(name: string, options: { git?: boolean } = {}): Promise<string> {
  const src = join(FIXTURES, name);
  const dir = await mkdtemp(join(tmpdir(), `st-${name}-`));
  await cp(src, dir, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes(".smarttest"),
  });
  await symlink(
    join(src, "node_modules"),
    join(dir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (options.git) {
    await writeFile(join(dir, ".gitignore"), "node_modules\n.smarttest/\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
  }
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=SmartTest",
      "-c",
      "user.email=ci@smarttest.dev",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

export async function edit(
  dir: string,
  file: string,
  find: string,
  replace: string,
): Promise<void> {
  const p = join(dir, file);
  const text = await readFile(p, "utf8");
  if (!text.includes(find)) throw new Error(`"${find}" not found in ${file}`);
  await writeFile(p, text.replace(find, replace));
}
