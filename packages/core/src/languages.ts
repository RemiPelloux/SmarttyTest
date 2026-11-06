/**
 * The language adapters, loaded on first use: they load TypeScript (about 9 MB), which commands
 * that neither read sources nor resolve imports (`doctor`, `explain` from the last decision, a
 * configuration in JSON or JavaScript) never need.
 */
import type { Analyzer } from "@smarttest/source-parser";

type TypeScriptLanguage = typeof import("@smarttest/language-typescript");
type PythonLanguage = typeof import("@smarttest/language-python");
type PhpLanguage = typeof import("@smarttest/language-php");

interface Languages {
  ts: TypeScriptLanguage;
  py: PythonLanguage;
  php: PhpLanguage;
  analyzers: Analyzer[];
}

let loading: Promise<Languages> | undefined;

export function languages(): Promise<Languages> {
  loading ??= (async () => {
    const [ts, js, py, php] = await Promise.all([
      import("@smarttest/language-typescript"),
      import("@smarttest/language-javascript"),
      import("@smarttest/language-python"),
      import("@smarttest/language-php"),
    ]);
    return {
      ts,
      py,
      php,
      analyzers: [ts.typescriptAnalyzer, js.javascriptAnalyzer, py.pythonAnalyzer, php.phpAnalyzer],
    };
  })();
  return loading;
}
