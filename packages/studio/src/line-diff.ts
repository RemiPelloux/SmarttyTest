/**
 * Minimal line diff for the Studio source viewer. The viewer marks which lines of the current file
 * the change added; it never claims a removed line is still there. The changed middle is diffed
 * with Myers' O((N+M)D) algorithm over interned lines; a diff whose edit distance or work exceeds
 * the budget falls back to marking the whole changed region, which is honest and still useful.
 */
export interface LineDiff {
  /** 1-based line numbers of the current file that the change added. */
  added: number[];
  /** How many lines the base had that the current file does not. */
  removed: number;
  /** True when the diff was approximated instead of computed line by line. */
  approximate: boolean;
}

/** Largest edit distance traced; the trace costs about D² integers. */
const MAX_EDITS = 2_000;
/** Upper bound on diagonal steps and snake comparisons before giving up. */
const MAX_WORK = 20_000_000;

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
  // Intern the changed middle so the inner loop compares integers, not strings.
  const ids = new Map<string, number>();
  const intern = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const xa = new Int32Array(n);
  const xb = new Int32Array(m);
  for (let i = 0; i < n; i++) xa[i] = intern(a[start + i] as string);
  for (let j = 0; j < m; j++) xb[j] = intern(b[start + j] as string);
  const script = myers(xa, xb);
  if (!script) {
    return {
      added: Array.from({ length: m }, (_, i) => start + i + 1),
      removed: n,
      approximate: true,
    };
  }
  return {
    added: script.added.map((j) => start + j + 1),
    removed: script.removed,
    approximate: false,
  };
}

/**
 * Shortest edit script between `a` and `b` (Myers 1986, forward pass with a stored trace).
 * Returns the 0-based indices of `b` that were inserted, ascending, and the number of deletions,
 * or null when the edit distance or the work exceeds the budget.
 */
function myers(a: Int32Array, b: Int32Array): { added: number[]; removed: number } | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;
  for (let d = 0; d <= limit && found === -1; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      const snakeStart = x;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      work += x - snakeStart + 1;
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (work > MAX_WORK) return null;
  }
  if (found === -1) return null;
  const added: number[] = [];
  let removed = 0;
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number): number => prev[k + d - 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (down) added.push(prevY);
    else removed++;
    x = prevX;
    y = prevY;
  }
  added.reverse();
  return { added, removed };
}
