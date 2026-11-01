/** Levenshtein distance — used for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = Math.min(
        (dp[j] as number) + 1,
        (dp[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Line-range diff by common prefix/suffix — conservative: one range spanning every change. */
export function changedLineRange(
  before: string,
  after: string,
): { start: number; end: number } | undefined {
  if (before === after) return undefined;
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { start, end: Math.max(endB, start) };
}

/** SGR parameters SmartTest's own colours use; anything else (conceal, blink…) is dropped. */
const SAFE_SGR = new Set("/0/1/2/22/30/31/32/33/35/36/37/39/41/42/43/100".split("/"));

const TERMINAL_ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /\u001b\[([0-9;]*)m|\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b[\s\S]?|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Makes text safe to print to a terminal. Test names, file paths, branch names and runner output
 * come from the repository: an escape sequence in them could move the cursor over a failure,
 * set the window title, write the clipboard (OSC 52) or forge a link. Keeps tab, newline and the
 * colour sequences SmartTest emits itself; removes every other escape and control character.
 */
export function terminalSafe(text: string): string {
  return text.replace(TERMINAL_ESCAPES, (match, sgr: string | undefined) =>
    sgr?.split(";").every((p) => SAFE_SGR.has(p)) ? match : "",
  );
}
