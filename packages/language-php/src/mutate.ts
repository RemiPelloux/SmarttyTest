/**
 * Fault injection for `smarttest audit --mutate` (preview): each named function and method with
 * a body gets `throw new \RuntimeException(...)` as its first statement.
 */
import { bracketPairs, tokenize } from "./tokenize.js";

export const PHP_MUTANT_ERROR = "throw new \\RuntimeException('smarttest audit: injected fault');";

export interface PhpMutationPoint {
  name: string;
  line: number;
  start: number;
  end: number;
  replacement: string;
}

export function phpMutationPoints(_path: string, text: string): PhpMutationPoint[] {
  const { toks } = tokenize(text);
  const pairs = bracketPairs(toks);
  const out: PhpMutationPoint[] = [];
  const classes: { name: string; close: number }[] = [];
  for (let k = 0; k < toks.length; k++) {
    while (classes.length && k > (classes[classes.length - 1] as { close: number }).close)
      classes.pop();
    const t = toks[k];
    if (t?.t !== "name" || t.inString) continue;
    const w = t.v.toLowerCase();
    const prev = toks[k - 1]?.v;
    if (
      (w === "class" || w === "trait" || w === "enum" || w === "interface") &&
      toks[k + 1]?.t === "name" &&
      prev !== "::" &&
      prev !== "new"
    ) {
      let open = k + 2;
      while (open < toks.length && toks[open]?.v !== "{") open++;
      const close = pairs[open] ?? -1;
      if (close > 0) classes.push({ name: toks[k + 1]?.v ?? "", close });
      continue;
    }
    if (w !== "function" || prev === "->" || prev === "::") continue;
    let n = k + 1;
    if (toks[n]?.v === "&") n++;
    const nameTok = toks[n];
    if (nameTok?.t !== "name" || toks[n + 1]?.v !== "(") continue; // a closure
    const pEnd = pairs[n + 1] ?? -1;
    if (pEnd < 0) continue;
    let b = pEnd + 1;
    while (b < toks.length && toks[b]?.v !== "{" && toks[b]?.v !== ";") b++;
    const brace = toks[b];
    if (brace?.v !== "{") continue; // abstract or interface method
    const owner = classes[classes.length - 1];
    out.push({
      name: owner ? `${owner.name}.${nameTok.v}` : nameTok.v,
      line: t.line,
      start: brace.end,
      end: brace.end,
      replacement: ` ${PHP_MUTANT_ERROR}`,
    });
  }
  return out;
}
