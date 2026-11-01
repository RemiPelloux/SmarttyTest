/**
 * The language adapters, loaded on first use: they load TypeScript (about 9 MB), which commands
 * that neither read sources nor resolve imports (`doctor`, `explain` from the last decision, a
 * configuration in JSON or JavaScript) never need.
 */
import type { Analyzer } from "@smarttest/source-parser";

type TypeScriptLanguage = typeof import("@smarttest/language-typescript");

let loading: Promise<{ ts: TypeScriptLanguage; analyzers: Analyzer[] }> | undefined;

export function languages(): Promise<{ ts: TypeScriptLanguage; analyzers: Analyzer[] }> {
  loading ??= (async () => {
    const [ts, js] = await Promise.all([
      import("@smarttest/language-typescript"),
      import("@smarttest/language-javascript"),
    ]);
    return { ts, analyzers: [ts.typescriptAnalyzer, js.javascriptAnalyzer] };
  })();
  return loading;
}
