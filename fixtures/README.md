# Fixtures

Small projects that the integration tests and the regression harness run against.

| Fixture                         | Stack                      | Runner                  | Covers                                                                                    |
| ------------------------------- | -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `projects/nest-auth-vitest`     | TypeScript services        | Vitest                  | member-level selection, inheritance, merge-base, deleted files                            |
| `projects/express-cjs-jest`     | Express (CommonJS)         | Jest                    | `require`, `module.exports` at symbol level                                               |
| `projects/pnpm-monorepo`        | pnpm workspace             | Vitest                  | cross-package imports, barrels                                                            |
| `projects/node-test-esm`        | plain ESM                  | `node:test`             | computed `import()` paths                                                                 |
| `projects/no-vcs-vitest`        | plain folder               | Vitest                  | native snapshots without a VCS                                                            |
| `projects/ts-lib-vitest`        | TypeScript library         | Vitest                  | path aliases, barrels, fluent APIs (`return this`)                                        |
| `projects/react-vitest`         | React components           | Vitest                  | TSX components rendered with `react-dom/server`                                           |
| `projects/yarn-workspaces-node` | Yarn workspaces, ESM       | `node:test`             | `yarn.lock`, workspaces, `node --test` with directory globs                               |
| `projects/next-playwright`      | Next.js `app/` conventions | Playwright, `node:test` | URL visits mapped to pages, layouts and API routes (small file-router server, no browser) |
| `projects/edges-vitest`         | env, assets, Wasp, Prisma  | Vitest                  | env keys, fs assets, translations, Wasp operations, Prisma models, snapshots, mocks       |

Each fixture has an `expected.json` with detection results and, for the regression harness, seeded mutations: the tests each mutation must make fail. The harness checks that those tests are selected and that a full run finds no failure the selection missed.
