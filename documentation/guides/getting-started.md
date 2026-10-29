# Getting started

> Implemented in **v0.1.0**. The behaviour on this page is covered by unit and integration tests.

## Requirements

- Node.js **22.12+** or **24** (LTS)
- A JavaScript or TypeScript project using **Jest** or **Vitest**
- npm, pnpm or Yarn. Git is optional.

## 1. Install

Once published:

```bash
npm install -D smarttest        # or: pnpm add -D smarttest · yarn add -D smarttest
```

Until the first npm release, build the self-contained package from source:

```bash
git clone https://github.com/RemiPelloux/SmarttyTest && cd SmarttyTest
corepack enable && pnpm install && pnpm build && pnpm bundle:cli
npm install -D /path/to/SmarttyTest/packages/cli/.publish     # in your project
```

## 2. Initialise

```bash
npx smarttest init --dry-run    # see exactly what would change
npx smarttest init              # review the plan, accept or edit each section
```

```text
Detected: NestJS + TypeScript + Jest · pnpm workspace (3 packages) · Git

Recommended
  Test layout      mirror        (82% of existing tests mirror src/)
  Adapter          jest          (jest.config.ts found in 3 packages)
  Change tracking  git + native snapshots
  Impact mode      balanced
  Coverage         existing Jest v8 provider

Warnings
  4 modules have no matching tests
  2 configuration files may affect all suites (tsconfig.base.json, jest.preset.js)

Changes
  + smarttest.config.ts
  ~ package.json        add scripts: "test:affected", "test:explain"
  ~ .gitignore          add .smarttest/
```

Init is **idempotent**: running it again changes nothing. It is also **reversible**: `npx smarttest init --rollback` undoes it.

## 3. Run what matters

```bash
npx smarttest run --affected            # vs. your working tree
npx smarttest run --affected --base main
npx smarttest run --all                 # full suite through the same pipeline
```

<p align="center"><img src="../assets/terminal.svg" alt="smarttest run --affected terminal session" width="90%"></p>

## 4. Ask why

```bash
npx smarttest explain src/auth/AuthService.test.ts
npx smarttest impact --base main --json   # decision only, no execution
```

## 5. Organise your tests

```bash
npx smarttest generate --sync            # missing / orphaned / renamed tests
npx smarttest generate --module auth --dry-run
```

Scaffolds use `it.todo(...)`, so a gap stays visible and is never counted as a passing test.

## 6. Reports

```bash
npx smarttest report --open              # self-contained HTML in .smarttest/reports/
```

## Next

- [How selection works](../concepts/how-selection-works.md) · [Safety model](../concepts/safety-model.md)
- [CLI reference](../reference/cli.md) · [Configuration](../reference/configuration.md)
- [GitHub Actions](ci-github-actions.md)
