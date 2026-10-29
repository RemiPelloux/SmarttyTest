# Configuration reference

SmartTest reads `smarttest.config.{ts,mts,js,mjs,json}` from the project root, or the file given with `--config`. `smarttest init` writes one for you. The file is transpiled on load, so `import { defineConfig } from "smarttest"` works even before the package is resolvable.

```ts
import { defineConfig } from "smarttest";

export default defineConfig({
  mode: "balanced",
  adapters: ["vitest"],
  vcs: { provider: "auto", base: "main", snapshots: true },
  snapshots: { storeContent: false, keep: 20 },
  tests: { layout: "mirror", directory: "tests", naming: "{FileName}.test.{Extension}" },
  generated: [{ path: "src/generated/**", policy: "exclude" }],
  triggers: ["db/schema.sql"],
  rules: [
    {
      name: "auth-critical",
      match: { path: "src/auth/**" },
      risk: "critical",
      execution: { alwaysRunOnAffected: true },
    },
  ],
  retries: 0,
  timeoutMs: 600000,
  reports: { formats: ["html", "json", "junit"], outputDir: ".smarttest/reports" },
});
```

| Key                      | Type                                              | Default                             | Notes                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                | `string[]`                                        | all `ts/tsx/mts/cts/js/jsx/mjs/cjs` | Globs of analysed files, relative to the root                                                                                                                                                                                            |
| `exclude`                | `string[]`                                        | —                                   | Added to built-in excludes (`node_modules`, `dist`, `build`, `coverage`, `.next`, `*.d.ts`…)                                                                                                                                             |
| `mode`                   | `"fast" \| "balanced" \| "safe"`                  | `"balanced"`                        | Overridable per run (`--mode`) and per rule                                                                                                                                                                                              |
| `adapters`               | `("vitest" \| "jest" \| "node")[]`                | detected                            | Restricts and orders runners                                                                                                                                                                                                             |
| `runners`                | `{ adapter, dir?, config?, patterns? }[]`         | detected                            | Explicit runners. Replaces detection (custom config names, `node --test` patterns)                                                                                                                                                       |
| `tests.discovery`        | `"runner" \| "static"`                            | `"runner"`                          | `runner`: each runner lists the files it collects (cached). `static`: filename patterns                                                                                                                                                  |
| `vcs.provider`           | `"auto" \| "git" \| "native"`                     | `"auto"`                            |                                                                                                                                                                                                                                          |
| `vcs.base`               | `string`                                          | —                                   | Default comparison ref for `run` / `impact`                                                                                                                                                                                              |
| `vcs.snapshots`          | `boolean`                                         | `true`                              | With Git, record a native snapshot after each fully passing run (`--since-snapshot`)                                                                                                                                                     |
| `snapshots.storeContent` | `boolean`                                         | `false`                             | Store compressed, deduplicated source content so snapshot diffs get line ranges                                                                                                                                                          |
| `snapshots.keep`         | `number`                                          | `20`                                | Default for `snapshot prune`                                                                                                                                                                                                             |
| `tests.layout`           | `"mirror" \| "colocated" \| "domain" \| "custom"` | detected                            | Generator layout                                                                                                                                                                                                                         |
| `tests.directory`        | `string`                                          | `"tests"`                           | Root for mirror/domain layouts                                                                                                                                                                                                           |
| `tests.naming`           | `string`                                          | `{FileName}.test.{Extension}`       | Tokens: `{ClassName} {FunctionName} {MethodName} {FileName} {ModuleName} {PackageName} {DomainName} {Type} {Extension}`                                                                                                                  |
| `tests.match`            | `string[]`                                        | Jest/Vitest defaults                | Globs that identify test files                                                                                                                                                                                                           |
| `tests.templates`        | `string`                                          | —                                   | Directory with `<template>.tpl` files (`{{source}}`, `{{scaffold}}`)                                                                                                                                                                     |
| `generated`              | `{ path, policy, from? }[]`                       | —                                   | `exclude` removes from analysis. Referenced generated files are still tracked as dependencies. With `rebuild-required` and `from` (generator input globs), a change to an input selects the tests of the outputs and warns to regenerate |
| `triggers`               | `string[]`                                        | —                                   | Extra mandatory triggers. Built-in ones (tsconfig, package.json, lockfiles, runner configs, setup files, `.env*`) cannot be removed                                                                                                      |
| `rules`                  | `Rule[]`                                          | `[]`                                | See [Rules](../concepts/rules.md)                                                                                                                                                                                                        |
| `retries`                | `number`                                          | `0`                                 | A pass after a retry is reported as **flaky**                                                                                                                                                                                            |
| `timeoutMs`              | `number`                                          | `600000`                            | Per-runner timeout                                                                                                                                                                                                                       |
| `workers`                | `number`                                          | runner default                      | Passed as `--maxWorkers`                                                                                                                                                                                                                 |
| `reports.formats`        | `("html" \| "json" \| "junit" \| "markdown")[]`   | `["html","json"]`                   |                                                                                                                                                                                                                                          |
| `reports.outputDir`      | `string`                                          | `".smarttest/reports"`              |                                                                                                                                                                                                                                          |
| `adaptive`               | `boolean`                                         | `true`                              | `run` selects every test without building the graph when the last full run took less time than a typical analysis (small suites)                                                                                                         |
| `projects`               | `Record<dir, { tests?, mode?, rules? }>`          | —                                   | Per-project conventions. `tests` (`layout`, `directory`, `naming`, `path`) applies to generated tests in that directory; `mode` is a minimum mode for its changes; `rules` are scoped to it (paths relative to the project)              |
| `storeDir`               | `string`                                          | `".smarttest"`                      | Local state. Git-ignored by init                                                                                                                                                                                                         |

Unknown keys produce warnings instead of being silently accepted.

## Per-project conventions

```ts
import { defineConfig } from "smarttest";

export default defineConfig({
  tests: { layout: "mirror", directory: "tests" },
  projects: {
    "FrontLeadsIt/app": {
      tests: { layout: "colocated", naming: "{FileName}.server.test.{Extension}" },
    },
    backend: {
      tests: { layout: "custom", path: "backend/src/__tests__/{FileName}.test.{Extension}" },
      mode: "safe",
    },
  },
});
```

`{ProjectDir}` is available in `path` and `naming` templates.
