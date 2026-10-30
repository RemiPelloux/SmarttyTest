import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff.js";

function lcsLength(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (table[i] as number[])[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as number[])[j] as number,
              (table[i] as number[])[j + 1] as number,
            );
  return (table[0] as number[])[0] as number;
}

function isSubsequence(small: string[], big: string[]): boolean {
  let i = 0;
  for (const line of big) if (i < small.length && small[i] === line) i++;
  return i === small.length;
}

describe("lineDiff", () => {
  it("marks every line of a new file as added", () => {
    expect(lineDiff(undefined, "a\nb")).toEqual({ added: [1, 2], removed: 0, approximate: false });
  });

  it("reports nothing for identical text", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual({ added: [], removed: 0, approximate: false });
  });

  it("counts a replaced line as one added and one removed", () => {
    expect(lineDiff("x", "y")).toEqual({ added: [1], removed: 1, approximate: false });
    expect(lineDiff("a\nx\nc", "a\ny\nc")).toEqual({
      added: [2],
      removed: 1,
      approximate: false,
    });
  });

  it("finds insertions and deletions inside the changed middle", () => {
    expect(lineDiff("a\nb\nc\nd\ne", "a\nc\nX\nd\nY\ne")).toEqual({
      added: [3, 5],
      removed: 1,
      approximate: false,
    });
  });

  it("handles pure insertions and pure deletions", () => {
    expect(lineDiff("a\nc", "a\nb\nc")).toEqual({ added: [2], removed: 0, approximate: false });
    expect(lineDiff("a\nb\nc", "a\nc")).toEqual({ added: [], removed: 1, approximate: false });
  });

  it("is a minimal diff on random inputs", () => {
    let seed = 7;
    const rand = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rand(14) }, () => String.fromCharCode(97 + rand(4)));
      const b = Array.from({ length: rand(14) }, () => String.fromCharCode(97 + rand(4)));
      const diff = lineDiff(a.join("\n"), b.join("\n"));
      // An empty string still splits into one (empty) line.
      const la = a.length ? a : [""];
      const lb = b.length ? b : [""];
      const lcs = lcsLength(la, lb);
      expect(diff.approximate).toBe(false);
      expect(diff.added.length).toBe(lb.length - lcs);
      expect(diff.removed).toBe(la.length - lcs);
      const addedSet = new Set(diff.added);
      const kept = lb.filter((_, i) => !addedSet.has(i + 1));
      expect(isSubsequence(kept, la)).toBe(true);
      expect([...diff.added].sort((x, y) => x - y)).toEqual(diff.added);
    }
  });

  it("diffs large files with few edits exactly and quickly", () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after.splice(10, 1, "changed");
    after.splice(40_000, 0, "inserted");
    const started = performance.now();
    const diff = lineDiff(before.join("\n"), after.join("\n"));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(diff).toEqual({ added: [11, 40_001], removed: 1, approximate: false });
  });

  it("falls back to marking the whole changed region when the edit distance is too large", () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join("\n");
    const diff = lineDiff(before, after);
    expect(diff.approximate).toBe(true);
    expect(diff.added.length).toBe(3_000);
    expect(diff.removed).toBe(3_000);
  });
});
