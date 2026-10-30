/**
 * Minimal line diff for the Studio source viewer. The viewer marks which lines of the current file
 * the change added; it never claims a removed line is still there. A diff that is too large for the
 * LCS table falls back to marking the whole changed region, which is honest and still useful.
 */
export interface LineDiff {
  /** 1-based line numbers of the current file that the change added. */
  added: number[];
  /** How many lines the base had that the current file does not. */
  removed: number;
  /** True when the diff was approximated instead of computed line by line. */
  approximate: boolean;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string | undefined, after: string): LineDiff {
  const a = (before ?? "").split("\n");
  const b = after.split("\n");
  if (before === undefined)
    return { added: b.map((_, i) => i + 1), removed: 0, approximate: false };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return { added: [], removed: 0, approximate: false };
  if (n === 0) {
    return {
      added: Array.from({ length: m }, (_, i) => start + i + 1),
      removed: 0,
      approximate: false,
    };
  }
  if (m === 0) return { added: [], removed: n, approximate: false };
  if (n * m > MAX_CELLS) {
    return {
      added: Array.from({ length: m }, (_, i) => start + i + 1),
      removed: n,
      approximate: true,
    };
  }
  // LCS table over the changed middle, then walk it to find lines that only exist on the new side.
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        a[start + i] === b[start + j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      i++;
    } else {
      added.push(start + j + 1);
      j++;
    }
  }
  while (j < m) {
    added.push(start + j + 1);
    j++;
  }
  const kept = i;
  return { added, removed: n - kept, approximate: false };
}
