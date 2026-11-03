/**
 * The language adapters, loaded on first use: they load TypeScript (about 9 MB), which commands
 * that neither read sources nor resolve imports (`doctor`, `explain` from the last decision, a
 * configuration in JSON or JavaScript) never need.
 */
import type { Analyzer } from "@smarttest/source-parser";

type TypeScriptLanguage = typeof import("@smarttest/language-typescript");
type PythonLanguage = typeof import("@smarttest/language-python");

let loading:
  | Promise<{ ts: TypeScriptLanguage; py: PythonLanguage; analyzers: Analyzer[] }>
  | undefined;

export function languages(): Promise<{
  ts: TypeScriptLanguage;
  py: PythonLanguage;
  analyzers: Analyzer[];
}> {
  loading ??= (async () => {
    const [ts, js, py] = await Promise.all([
      import("@smarttest/language-typescript"),
      import("@smarttest/language-javascript"),
      import("@smarttest/language-python"),
    ]);
    return { ts, py, analyzers: [ts.typescriptAnalyzer, js.javascriptAnalyzer, py.pythonAnalyzer] };
  })();
  return loading;
}
