/**
 * Fault injection for `smarttest audit --mutate` (preview): each function or method with an
 * indented body gets `raise RuntimeError(...)` as its first statement.
 */
import { analyzePython, tokenize } from "./analyze.js";

export const PYTHON_MUTANT_ERROR = 'raise RuntimeError("smarttest audit: injected fault")';

export interface PythonMutationPoint {
  name: string;
  line: number;
  start: number;
  end: number;
  replacement: string;
}

export function pythonMutationPoints(path: string, text: string): PythonMutationPoint[] {
  const src = text.replace(/\r\n?/g, "\n");
  if (src !== text) return []; // offsets below are for "\n" line endings only
  const { lines } = tokenize(src);
  const lineStart: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStart.push(i + 1);
  const out: PythonMutationPoint[] = [];
  for (const s of analyzePython(path, src).symbols) {
    if (s.kind !== "function" && s.kind !== "method" && !(s.kind === "property" && s.parent))
      continue;
    // The `def` logical line (after any decorator) and the first line of its body.
    const def = lines.findIndex(
      (l) =>
        l.start >= s.range.start.line &&
        l.start <= s.range.end.line &&
        (l.toks[0]?.v === "def" || (l.toks[0]?.v === "async" && l.toks[1]?.v === "def")),
    );
    const head = lines[def];
    const body = lines[def + 1];
    // One-line definitions (`def f(): return 1`) have no indented body to put a statement in.
    if (!head || head.toks.at(-1)?.v !== ":" || !body || body.indent <= head.indent) continue;
    const at = (lineStart[head.end] ?? src.length) - 1; // the newline ending the signature
    out.push({
      name: s.qualifiedName,
      line: head.start,
      start: at,
      end: at,
      replacement: `\n${" ".repeat(body.indent)}${PYTHON_MUTANT_ERROR}`,
    });
  }
  return out;
}
