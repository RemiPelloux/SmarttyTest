# Angular

SmartTest selects and runs the specs of Angular CLI workspaces. Most of an Angular application is ordinary TypeScript, which SmartTest already analyses. This guide covers what is specific to Angular: templates and styles loaded by path, `ng test`, and `angular.json`.

## Supported setups

| Setup                                                                                                                  | How SmartTest runs the specs                     | Type errors fail the run |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------ |
| `@angular/build:unit-test` with Vitest (the default since Angular 21)                                                  | `ng test <project> --include <spec>…`            | yes                      |
| `@angular-builders/jest:run`                                                                                           | `ng test <project> --test-path-patterns <spec>…` | no                       |
| `jest-preset-angular` with a `jest.config.*` (no `ng test` target)                                                     | Jest directly                                    | no                       |
| `@analogjs/vitest-angular` with a `vite.config.*`/`vitest.config.*`                                                    | Vitest directly                                  | no                       |
| Karma (`@angular/build:karma`, `@angular-devkit/build-angular:karma`, or the unit-test builder with `runner: "karma"`) | not run: `ST_ANGULAR_KARMA_UNSUPPORTED`          | —                        |

Each project of an `angular.json` whose `test` target uses one of the `ng test` builders is its own runner, named after the project: `smarttest doctor` shows `angular (angular.json) collects 12 test file(s)`. To declare one by hand, for example when two projects share a directory and you want only one:

```ts
export default defineConfig({
  runners: [{ adapter: "angular", config: "angular.json", project: "shop" }],
});
```

**Karma.** Karma gives no report per test, so SmartTest cannot say which spec failed. Rather than report a run from its exit code alone, it stops with `ST_ANGULAR_KARMA_UNSUPPORTED`. Angular's migration (`ng generate @schematics/angular:refactor-jasmine-vitest`) moves a project to the unit-test builder with Vitest.

**Nx workspaces** (projects in `project.json`, run with `nx test`) are not read yet; they are part of the monorepo orchestration planned for 1.4.0.

## What selects a spec

| You change                                                                               | Selected                                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A component's template (`templateUrl`) or stylesheet (`styleUrl`, `styleUrls`)           | The specs that reach that component                                                          |
| A Sass, Less or CSS file another stylesheet imports (`@use`, `@forward`, `@import`)      | The specs of every component whose stylesheet imports it, directly or through other partials |
| A component, service, pipe, guard or route file                                          | The specs that reach the code that changed, as in any TypeScript project                     |
| Any file a spec reaches, on a builder that type-checks (see the table above)             | That spec, whatever unit changed: a type error there fails `ng test`                         |
| `angular.json`, the test target's `tsConfig` (`tsconfig.spec.json`), `runnerConfig`      | Every spec of that project                                                                   |
| A `setupFiles` or `providersFile`, a polyfill file, a global `styles` or `scripts` entry | Every spec of that project                                                                   |
| A file in `fileReplacements` (`environment.development.ts`)                              | The specs that reach the file it replaces (`environment.ts`)                                 |
| A comment or formatting only                                                             | Nothing new                                                                                  |

Lazy routes are imports: `loadComponent: () => import("./a")`, `loadChildren: () => import("./b.routes")`, and the legacy string form `loadChildren: "./c/c.module#CModule"`.

Dependency injection needs nothing special. `inject(Service)`, constructor parameters and `providers: [Service]` all import their token, so a change to a service selects the specs that reach it through those imports.

## What is uncertainty

A template or style path SmartTest cannot evaluate (`templateUrl: pick()`) is uncertainty: in BALANCED and SAFE the specs that reach that component are selected. A partial imported through a load path (`stylePreprocessorOptions.includePaths`, `@use "abstracts/vars"`) is matched by path suffix, which may select more specs than strictly needed, never fewer.

## Reading `explain`

```text
$ smarttest explain src/app/badge/badge.spec.ts
[SELECTED]  src/app/badge/badge.spec.ts
Reasons
  • Directly depends on src/app/badge/badge.ts#Badge
  src/app/badge/badge.ts#Badge → src/app/badge/badge.spec.ts
```

After a template change, the reason names the component that loads the template (`badge.ts#Badge`), because the template belongs to that class. After a change to `angular.json` or a setup file, the reason names the option: `src/styles.scss changed — global stylesheet of angular (styles in angular.json)`.
