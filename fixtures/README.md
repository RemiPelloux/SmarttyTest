# Fixtures

Realistic fixture projects that cover the 1.0 compatibility matrix (story **ST-005**). Every engine is tested against them.

| Fixture                     | Stack                   | Runner | Notes                                    |
| --------------------------- | ----------------------- | ------ | ---------------------------------------- |
| `projects/ts-lib-vitest`    | TypeScript library      | Vitest | ESM, path aliases                        |
| `projects/react-vitest`     | React + Vite            | Vitest | JSX/TSX                                  |
| `projects/nextjs-jest`      | Next.js                 | Jest   | generated `.next/`                       |
| `projects/express-cjs-jest` | Express (CommonJS JS)   | Jest   | `require`, dynamic requires              |
| `projects/nestjs-jest`      | NestJS                  | Jest   | decorators, DI, the spec's `auth` module |
| `projects/pnpm-monorepo`    | pnpm workspace (3 pkgs) | mixed  | cross-package imports, `exports` maps    |
| `projects/yarn-esm`         | Yarn berry, ESM         | Vitest |                                          |
| `projects/no-vcs`           | plain folder            | Vitest | native snapshots                         |

Each fixture includes an `expected.json` (detection results plus known test↔source relationships) and seeded mutations for the regression harness (ST-095).
