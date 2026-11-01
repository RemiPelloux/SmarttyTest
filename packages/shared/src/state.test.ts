import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStateFile,
  readStateFileSync,
  readStateJson,
  stateKey,
  stateKeyFile,
  writeStateFile,
  writeStateJson,
} from "./state.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dir() {
  const d = await mkdtemp(join(tmpdir(), "st-state-"));
  dirs.push(d);
  return d;
}

describe("authenticated state (SR-16)", () => {
  it("reads back what this key wrote", async () => {
    const path = join(await dir(), "results.json");
    await writeStateJson(path, { version: 1, files: {} });
    expect(await readStateJson(path)).toEqual({ version: 1, files: {} });
    expect(readStateFileSync(path)).toContain('"version": 1');
  });

  it("treats a planted, edited or foreign file as absent", async () => {
    const d = await dir();
    // Planted: no MAC at all (a pull request or a cache from elsewhere).
    const planted = join(d, "index.json");
    await writeFile(planted, '{"schemaVersion":2,"files":{}}');
    expect(await readStateFile(planted)).toBeUndefined();
    expect(readStateFileSync(planted)).toBeUndefined();
    // Edited after it was written: the MAC no longer matches.
    const edited = join(d, "graph.json");
    await writeStateFile(edited, "header\nbody");
    await writeFile(edited, "header\nbody without edges");
    expect(await readStateFile(edited)).toBeUndefined();
    // A MAC copied from another file does not vouch for this one.
    const other = join(d, "traces.json");
    await writeStateFile(other, "header\nbody");
    await writeFile(join(d, "graph.json"), "header\nbody");
    await writeFile(join(d, "graph.json.mac"), await readFile(`${other}.mac`, "utf8"));
    expect(await readStateFile(join(d, "graph.json"))).toBeUndefined();
  });

  it("does not trust state written under another key (another machine, a fork's CI job)", async () => {
    const path = join(await dir(), "discovery.json");
    vi.stubEnv("SMARTTEST_STATE_KEY", "a".repeat(40));
    await writeStateJson(path, { k: ["test/a.test.ts"] });
    expect(await readStateJson(path)).toEqual({ k: ["test/a.test.ts"] });
    vi.stubEnv("SMARTTEST_STATE_KEY", "b".repeat(40));
    expect(await readStateJson(path)).toBeUndefined();
  });

  it("warns once when SMARTTEST_STATE_KEY is too short to be used", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      vi.stubEnv("SMARTTEST_STATE_KEY", "too-short");
      stateKey();
      stateKey();
      const warnings = write.mock.calls.map((c) => String(c[0]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("SMARTTEST_STATE_KEY");
      expect(warnings[0]).toContain("at least 32");
    } finally {
      write.mockRestore();
    }
  });

  it("keeps the per-user key outside every project", () => {
    expect(stateKeyFile({ XDG_CACHE_HOME: "/home/u/.cache" })).toMatch(
      process.platform === "linux" ? /^\/home\/u\/\.cache\/smarttest\/state\.key$/ : /state\.key$/,
    );
  });
});
