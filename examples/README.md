# Examples

The fixture projects in [`fixtures/projects/`](../fixtures/projects) are real, runnable projects. They double as examples.

| Project            | Shows                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `nest-auth-vitest` | TypeScript + Vitest, path aliases, symbol-level selection, rules (`auth-critical`), coverage |
| `express-cjs-jest` | CommonJS JavaScript + Jest (file-level analysis of CJS modules)                              |
| `pnpm-monorepo`    | Workspaces, `exports` maps pointing at `dist/`, barrels, cross-package selection             |
| `no-vcs-vitest`    | No version control: native snapshots, first run = full suite, then incremental               |

## Walkthrough

```bash
pnpm install && pnpm build            # from the repository root
ST="$PWD/packages/cli/dist/bin.js"

cp -r fixtures/projects/nest-auth-vitest /tmp/demo
ln -s "$PWD/fixtures/projects/nest-auth-vitest/node_modules" /tmp/demo/node_modules
cd /tmp/demo && git init -q && git add -A && git commit -qm init

node $ST init --dry-run               # the explained plan
node $ST init --yes                   # apply (undo: init --rollback)
sed -i.bak 's/sum + p.price/sum - p.price/' src/modules/catalog/CatalogService.ts
node $ST run                          # 1 of 7 selected → fails, 6 not run
node $ST explain tests/unit/modules/catalog/CatalogService.test.ts
node $ST validate-selection           # compare with a full run: 0 missed
node $ST generate --dry-run           # missing test files, as it.todo scaffolds
node $ST report --open
```
