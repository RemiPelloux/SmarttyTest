import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobReader } from "./cat-file.js";
import { GitAdapter } from "./index.js";

const CONFIG = ["-c", "core.quotePath=false"];

async function repo(files: Record<string, string | Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "st-catfile-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(files)) await writeFile(join(dir, p), c);
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  return { dir, git };
}

const show = (dir: string, name: string) =>
  execFileSync("git", ["show", name], { cwd: dir, encoding: "utf8" });

describe("previous versions through one git cat-file --batch", () => {
  it("reads many files concurrently, exactly as git show prints them", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++)
      files[`f${i}.ts`] = `export const v${i} = ${"x".repeat(i * 97)};\n`;
    files["empty.ts"] = "";
    files["unicode.ts"] = "export const s = 'é漢字🙂';\n";
    files["no-newline.ts"] = "export const n = 1;";
    const { dir } = await repo(files);
    const blobs = new BlobReader(CONFIG);
    try {
      const names = Object.keys(files);
      const read = await Promise.all(names.map((f) => blobs.read(dir, "HEAD", f)));
      for (const [i, f] of names.entries()) expect(read[i]).toBe(show(dir, `HEAD:${f}`));
    } finally {
      blobs.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("answers undefined for a path that does not exist, and keeps answering after it", async () => {
    const { dir } = await repo({ "a.ts": "export const a = 1;\n" });
    const blobs = new BlobReader(CONFIG);
    try {
      expect(await blobs.read(dir, "HEAD", "missing.ts")).toBeUndefined();
      expect(await blobs.read(dir, "HEAD", "a.ts")).toBe("export const a = 1;\n");
    } finally {
      blobs.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns binary content whole, decoded like git show", async () => {
    const bytes = Buffer.from([0, 1, 2, 10, 255, 254, 10, 0, 13, 10]);
    const { dir } = await repo({ "bin.dat": bytes });
    const blobs = new BlobReader(CONFIG);
    try {
      const text = await blobs.read(dir, "HEAD", "bin.dat");
      expect(text).toBe(bytes.toString("utf8"));
    } finally {
      blobs.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to git show when the batch process dies, never answering empty", async () => {
    const { dir } = await repo({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 2;\n",
    });
    const blobs = new BlobReader(CONFIG);
    try {
      expect(await blobs.read(dir, "HEAD", "a.ts")).toBe("export const a = 1;\n");
      const procs = (blobs as unknown as { processes: Map<string, { child: { kill(): void } }> })
        .processes;
      for (const p of procs.values()) p.child.kill();
      const pending = blobs.read(dir, "HEAD", "b.ts");
      expect(await pending).toBe("export const b = 2;\n");
      expect(await blobs.read(dir, "HEAD", "a.ts")).toBe("export const a = 1;\n");
    } finally {
      blobs.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is what readBefore uses: one process for many changed files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = `export const v = ${i};\n`;
    const { dir } = await repo(files);
    try {
      for (let i = 0; i < 20; i++) await writeFile(join(dir, `f${i}.ts`), "changed\n");
      const input = await new GitAdapter(dir).getChangeInput({ kind: "uncommitted" });
      const before = await Promise.all(
        Array.from({ length: 20 }, (_, i) => input.readBefore(`f${i}.ts`)),
      );
      expect(before).toEqual(Array.from({ length: 20 }, (_, i) => `export const v = ${i};\n`));
      expect(await input.readBefore("nope.ts")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
