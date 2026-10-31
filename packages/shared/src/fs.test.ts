import * as fsp from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "./fs.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const locked = (code: string) => Object.assign(new Error(code), { code });
const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(fsp.rename).mockReset();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  it("retries a rename refused while another process has the file open (Windows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-atomic-"));
    dirs.push(dir);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsp.rename)
      .mockRejectedValueOnce(locked("EPERM"))
      .mockRejectedValueOnce(locked("EBUSY"))
      .mockImplementation(actual.rename);
    await writeFileAtomic(join(dir, "index.json"), "new\n");
    expect(await readFile(join(dir, "index.json"), "utf8")).toBe("new\n");
    expect(fsp.rename).toHaveBeenCalledTimes(3);
  });

  it("gives up on other errors and leaves no temporary file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-atomic-"));
    dirs.push(dir);
    vi.mocked(fsp.rename).mockRejectedValue(locked("ENOSPC"));
    await expect(writeFileAtomic(join(dir, "index.json"), "x")).rejects.toThrow("ENOSPC");
    expect(fsp.rename).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });
});
