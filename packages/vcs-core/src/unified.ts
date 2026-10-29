/** Changed line ranges (0-based, new file) from a unified diff with zero context, any VCS. */
import type { SourceRange } from "@smarttest/shared";

export function parseUnifiedRanges(
  diff: string,
  toPath: (header: string) => string | undefined,
): Map<string, SourceRange[]> {
  const out = new Map<string, SourceRange[]>();
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = toPath(line.slice(4));
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current) {
      const start = Math.max(0, Number(m[1]) - 1);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      out.get(current)?.push({
        start: { line: start, column: 0 },
        end: { line: count === 0 ? start : start + count - 1, column: Number.MAX_SAFE_INTEGER },
      });
    }
  }
  return out;
}
