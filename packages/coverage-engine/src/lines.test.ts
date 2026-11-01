import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestBrowserV8, ingestIstanbulLines, istanbulLines, sha256, v8Lines } from "./index.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "st-cov-lines-"));
  await mkdir(join(root, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const loc = (line: number, endLine = line) => ({
  start: { line, column: 0 },
  end: { line: endLine, column: 1 },
});

describe("istanbul line detail", () => {
  it("keeps per-line hits and per-arm branch hits", () => {
    const detail = istanbulLines({
      statementMap: { "0": loc(1), "1": loc(2), "2": loc(2), "3": loc(4, 6) },
      s: { "0": 3, "1": 0, "2": 1, "3": 0 },
      branchMap: { "0": { type: "if", loc: loc(2), locations: [loc(2), loc(4)] } },
      b: { "0": [1, 0] },
    });
    expect([...detail.lines.entries()]).toEqual([
      [1, 3],
      [2, 1],
      [4, 0],
    ]);
    expect(detail.branches).toEqual([{ line: 2, type: "if", arms: [1, 0] }]);
  });

  it("ingests coverage-final.json with the file hash, run and scope, and adds up runner roots", async () => {
    const text = "export const a = 1;\nexport function f(x) {\n  return x ? 1 : 2;\n}\n";
    await writeFile(join(root, "src/a.ts"), text);
    const entry = (hits: number) => ({
      path: join(root, "src/a.ts"),
      statementMap: { "0": loc(1), "1": loc(3) },
      s: { "0": 1, "1": hits },
      branchMap: { "0": { type: "cond-expr", loc: loc(3) } },
      b: { "0": [hits, 0] },
    });
    const one = join(root, "one.json");
    const two = join(root, "two.json");
    await writeFile(one, JSON.stringify({ [join(root, "src/a.ts")]: entry(0) }));
    await writeFile(
      two,
      JSON.stringify({
        [join(root, "src/a.ts")]: entry(2),
        "/elsewhere/outside.ts": { ...entry(1), path: "/elsewhere/outside.ts" },
      }),
    );
    const report = await ingestIstanbulLines(
      [one, two, join(root, "missing.json")],
      root,
      "selected",
      "run-1",
    );
    expect(report?.origin).toBe("istanbul");
    expect(report?.scope).toBe("selected");
    expect(report?.runId).toBe("run-1");
    expect(Object.keys(report?.files ?? {})).toEqual(["src/a.ts"]);
    const file = report?.files["src/a.ts"];
    expect(file?.sha256).toBe(sha256(text));
    expect(file?.lines).toEqual([
      [1, 2],
      [3, 2],
    ]);
    expect(file?.branches).toEqual([{ line: 3, type: "cond-expr", arms: [2, 0] }]);
  });

  it("returns undefined when no report was written", async () => {
    expect(await ingestIstanbulLines([join(root, "none.json")], root, "full", "r")).toBeUndefined();
  });
});

describe("browser V8 line detail", () => {
  const source = [
    "// a comment",
    "export function pick(x) {",
    "  if (x) {",
    "    return 1;",
    "  }",
    "  return 2;",
    "}",
    "",
  ].join("\n");
  const at = (needle: string) => source.indexOf(needle);
  const functions = [
    {
      functionName: "",
      isBlockCoverage: false,
      ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
    },
    {
      functionName: "pick",
      isBlockCoverage: true,
      ranges: [
        { startOffset: at("export function"), endOffset: source.lastIndexOf("}") + 1, count: 2 },
        // The if body never ran.
        { startOffset: at("{\n    return 1"), endOffset: at("  }\n  return 2"), count: 0 },
      ],
    },
  ];

  it("counts a line by the innermost range at its first character and skips comments", () => {
    const detail = v8Lines(source, functions);
    const lines = Object.fromEntries(detail.lines);
    expect(lines[1]).toBeUndefined();
    expect(lines[2]).toBe(2);
    expect(lines[3]).toBe(2);
    expect(lines[4]).toBe(0);
    expect(lines[6]).toBe(2);
    expect(detail.branches).toEqual([{ line: 3, type: "block", arms: [0] }]);
  });

  it("maps a script only when it is the project file byte for byte", async () => {
    await writeFile(join(root, "src/pick.js"), source);
    await writeFile(join(root, "src/bundled.js"), source);
    const dir = join(root, "v8");
    await mkdir(dir);
    await writeFile(
      join(dir, "t1.json"),
      JSON.stringify({
        testFile: "e2e/a.spec.ts",
        entries: [
          { url: "http://127.0.0.1:5173/src/pick.js", source, functions },
          {
            url: "http://127.0.0.1:5173/src/bundled.js",
            source: `${source}//# sourceMappingURL=x`,
            functions,
          },
          { url: "http://127.0.0.1:5173/assets/index-abc.js", source: "x", functions: [] },
          { url: "http://127.0.0.1:5173/%2e%2e/%2e%2e/etc/passwd", source: "x", functions: [] },
          { url: "http://127.0.0.1:5173/src/nosource.js", functions: [] },
        ],
      }),
    );
    await writeFile(
      join(dir, "t2.json"),
      JSON.stringify({
        entries: [{ url: "http://localhost:5173/src/pick.js", source, functions }],
      }),
    );
    const report = await ingestBrowserV8([dir, join(root, "absent")], root, "selected", "run-2");
    expect(report?.origin).toBe("browser-v8");
    expect(Object.keys(report?.files ?? {})).toEqual(["src/pick.js"]);
    // Two tests ran the same file: hits add up.
    expect(Object.fromEntries(report?.files["src/pick.js"]?.lines ?? [])[2]).toBe(4);
    const reasons = Object.fromEntries((report?.unmapped ?? []).map((u) => [u.url, u.reason]));
    expect(reasons["http://127.0.0.1:5173/src/bundled.js"]).toMatch(/transformed or bundled/);
    expect(reasons["http://127.0.0.1:5173/assets/index-abc.js"]).toMatch(/does not resolve/);
    expect(reasons["http://127.0.0.1:5173/src/nosource.js"]).toMatch(/did not report/);
    expect(Object.keys(reasons).some((u) => u.includes("passwd"))).toBe(true);
    expect(Object.keys(report?.files ?? {}).some((f) => f.includes("passwd"))).toBe(false);
  });

  it("reports project-relative paths when the root is reached through a link (SR-21)", async () => {
    await writeFile(join(root, "src/pick.js"), source);
    // A file outside the project with the very source the browser reports.
    const outside = await mkdtemp(join(tmpdir(), "st-outside-"));
    await writeFile(join(outside, "x.js"), source);
    const dir = join(root, "v8");
    await mkdir(dir);
    await writeFile(
      join(dir, "t.json"),
      JSON.stringify({
        entries: [
          { url: "http://127.0.0.1:5173/src/pick.js", source, functions },
          { url: `http://127.0.0.1:5173/@fs${outside}/x.js`, source, functions },
          { url: `file://${outside}/x.js`, source, functions },
        ],
      }),
    );
    const linked = `${root}-link`;
    await symlink(root, linked, "junction");
    try {
      const report = await ingestBrowserV8([dir], linked, "selected", "r");
      expect(Object.keys(report?.files ?? {})).toEqual(["src/pick.js"]);
    } finally {
      await rm(linked, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("returns undefined when no browser wrote a dump", async () => {
    expect(await ingestBrowserV8([join(root, "nothing")], root, "selected", "r")).toBeUndefined();
  });
});
