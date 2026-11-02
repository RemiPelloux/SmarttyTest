import { describe, expect, it } from "vitest";
import { angularTestTargets } from "./angular.js";

const workspace = {
  projects: {
    shop: {
      root: "",
      sourceRoot: "src",
      architect: {
        build: {
          builder: "@angular/build:application",
          options: {
            tsConfig: "tsconfig.app.json",
            polyfills: ["zone.js", "src/polyfills.ts"],
            styles: ["src/styles.scss", { input: "src/theme.scss", bundleName: "theme" }],
            scripts: [],
          },
        },
        test: {
          builder: "@angular/build:unit-test",
          options: { setupFiles: ["src/test-setup.ts"], providersFile: "src/test-providers.ts" },
        },
      },
    },
    ui: {
      root: "projects/ui",
      architect: {
        test: {
          builder: "@angular-devkit/build-angular:karma",
          options: { karmaConfig: "projects/ui/karma.conf.js", include: ["**/*.spec.ts"] },
        },
      },
    },
    docs: {
      root: "projects/docs",
      architect: { build: { builder: "@angular/build:application" } },
    },
  },
};

describe("angularTestTargets", () => {
  it("lists each project with a test builder, its runner and what every spec loads", () => {
    const [shop, ui, ...rest] = angularTestTargets(JSON.stringify(workspace));
    expect(rest).toEqual([]);
    expect(shop).toMatchObject({
      project: "shop",
      sourceRoot: "src",
      runner: "vitest",
      include: ["**/*.spec.ts", "**/*.test.ts"],
    });
    expect(shop?.loads).toEqual([
      { file: "tsconfig.app.json", key: "tsConfig" },
      { file: "src/polyfills.ts", key: "polyfills" },
      { file: "src/styles.scss", key: "styles" },
      { file: "src/theme.scss", key: "styles" },
      { file: "src/test-setup.ts", key: "setupFiles" },
      { file: "src/test-providers.ts", key: "providersFile" },
      // The unit-test builder's default, used when the file exists.
      { file: "tsconfig.spec.json", key: "tsConfig" },
    ]);
    expect(ui).toMatchObject({ project: "ui", sourceRoot: "projects/ui/src", runner: "karma" });
    expect(ui?.loads).toEqual([{ file: "projects/ui/karma.conf.js", key: "karmaConfig" }]);
  });

  it("defaults the unit-test builder's tsconfig to tsconfig.spec.json in the project root", () => {
    const [t] = angularTestTargets(
      JSON.stringify({
        projects: {
          a: { root: "apps/a", architect: { test: { builder: "@angular/build:unit-test" } } },
        },
      }),
    );
    expect(t?.loads).toEqual([{ file: "apps/a/tsconfig.spec.json", key: "tsConfig" }]);
  });

  it("reads one Nx project.json (targets/executor)", () => {
    const [t] = angularTestTargets(
      JSON.stringify({
        sourceRoot: "apps/web/src",
        targets: { test: { executor: "@angular/build:unit-test", options: { runner: "karma" } } },
      }),
      "web",
    );
    expect(t).toMatchObject({ project: "web", runner: "karma", sourceRoot: "apps/web/src" });
  });

  it("@angular-builders/jest: Jest, its config and no type-checking", () => {
    const [t] = angularTestTargets(
      JSON.stringify({
        projects: {
          a: {
            root: "",
            architect: {
              test: {
                builder: "@angular-builders/jest:run",
                options: { config: "jest.app.config.js", setupFilesAfterEnv: "src/setup-jest.ts" },
              },
            },
          },
        },
      }),
    );
    expect(t).toMatchObject({ runner: "jest", typeChecks: false });
    expect(t?.loads).toEqual([
      { file: "jest.app.config.js", key: "config" },
      { file: "src/setup-jest.ts", key: "setupFilesAfterEnv" },
      { file: "tsconfig.spec.json", key: "tsConfig" },
    ]);
  });

  it("fileReplacements of every build configuration", () => {
    const [t] = angularTestTargets(
      JSON.stringify({
        projects: {
          a: {
            root: "",
            sourceRoot: "src",
            architect: {
              build: {
                builder: "@angular/build:application",
                configurations: {
                  development: {
                    fileReplacements: [
                      {
                        replace: "src/environments/environment.ts",
                        with: "src/environments/environment.development.ts",
                      },
                    ],
                  },
                },
              },
              test: { builder: "@angular/build:unit-test" },
            },
          },
        },
      }),
    );
    expect(t?.replacements).toEqual([
      {
        replace: "src/environments/environment.ts",
        with: "src/environments/environment.development.ts",
      },
    ]);
  });

  it("returns nothing for text that is not a workspace", () => {
    expect(angularTestTargets("{ not json")).toEqual([]);
  });
});
