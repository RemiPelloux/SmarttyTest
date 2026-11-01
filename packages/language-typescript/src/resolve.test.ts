import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TypeScriptResolver } from "./resolve.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "st-resolve-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

describe("TypeScriptResolver", () => {
  it("resolves bundler query imports to the file they name, relative or through an alias", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          paths: { "#web/*": ["./src/*"] },
        },
      }),
      "src/assets/icon.svg": "<svg/>",
      "src/ui/style.css": "a{}",
      "src/ui/Icon.tsx": "export {};",
      "src/work.ts": "export {};",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/ui/Icon.tsx", "#web/assets/icon.svg?raw")).toEqual({
      resolved: "src/assets/icon.svg",
    });
    expect(r.resolve("src/ui/Icon.tsx", "#web/assets/icon.svg")).toEqual({
      resolved: "src/assets/icon.svg",
    });
    expect(r.resolve("src/ui/Icon.tsx", "../assets/icon.svg?url")).toEqual({
      resolved: "src/assets/icon.svg",
    });
    expect(r.resolve("src/ui/Icon.tsx", "./style.css?inline")).toEqual({
      resolved: "src/ui/style.css",
    });
    expect(r.resolve("src/ui/Icon.tsx", "#web/work?worker")).toEqual({ resolved: "src/work.ts" });
  });

  it("still reports an alias that names no file as unresolved", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#web/*": ["./src/*"] } } }),
      "src/a.ts": "export {};",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/a.ts", "#web/missing.svg?raw")).toEqual({
      reason: 'path alias "#web/*" did not resolve "#web/missing.svg"',
    });
  });

  // OpenPro's admin: Vite's template keeps `paths` in tsconfig.app.json, referenced from a
  // tsconfig.json with no options. `@hooks/…` was taken for an npm package: 44% of the graph lost.
  it("follows the references of a solution-style tsconfig.json to their paths", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
      }),
      "tsconfig.app.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@hooks/*": ["src/hooks/*"] } },
        include: ["src"],
      }),
      "tsconfig.node.json": JSON.stringify({ include: ["vite.config.ts"] }),
      "src/hooks/useThing.ts": "export {};",
      "src/pages/Page.tsx": "export {};",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/pages/Page.tsx", "@hooks/useThing")).toEqual({
      resolved: "src/hooks/useThing.ts",
    });
  });

  // Audit p2/p9/p12: "installed" was read from node_modules, so nothing installed meant every
  // name counted, and a name pnpm's store, npm hoisting or Yarn PnP held counted too.
  it("counts a bare import as a package only when a package.json declares it", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        name: "app",
        dependencies: { "declared-pkg": "1" },
        devDependencies: { "@types/typed-only": "1" },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/a.ts": "export {};",
      "node_modules/real-pkg/package.json": JSON.stringify({ name: "real-pkg", main: "index.js" }),
      "node_modules/real-pkg/index.js": "",
      "node_modules/entities/package.json": JSON.stringify({ name: "entities" }),
      "node_modules/.pnpm/node_modules/@scope/stored/package.json": JSON.stringify({
        name: "@scope/stored",
      }),
      ".pnp.cjs": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/a.ts", "@hooks/useThing")).toEqual({
      reason: '"@hooks/useThing" is neither a path alias nor a declared dependency',
    });
    // Installed and resolvable by TypeScript: a package, declared or not.
    expect(r.resolve("src/a.ts", "real-pkg")).toEqual({ external: true });
    // Declared but not installed yet.
    expect(r.resolve("src/a.ts", "declared-pkg/sub")).toEqual({ external: true });
    for (const spec of ["@scope/stored/sub", "entities/user", "@/lib/a", "typed-only"])
      expect(r.resolve("src/a.ts", spec)).toMatchObject({ reason: expect.any(String) });
    expect(r.resolve("src/a.ts", "node:fs")).toEqual({ external: true });
    expect(r.resolve("src/a.ts", "fs/promises")).toEqual({ external: true });
  });

  it("reads declared dependencies up to the workspace root", async () => {
    const root = await project({
      "package.json": JSON.stringify({ workspaces: ["apps/*"], devDependencies: { shared: "1" } }),
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { own: "1" } }),
      "apps/web/src/a.ts": "export {};",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("apps/web/src/a.ts", "own")).toEqual({ external: true });
    expect(r.resolve("apps/web/src/a.ts", "shared")).toEqual({ external: true });
    expect(r.resolve("apps/web/src/a.ts", "other")).toMatchObject({ reason: expect.any(String) });
  });

  // Audit p1: the builtin check ran first and on the first segment only.
  it("resolves local names that look like Node builtins before calling them builtins", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
      "src/domain/user.ts": "export {};",
      "src/constants.ts": "export {};",
      "src/events/x.ts": "export {};",
      "src/app.ts": "export {};",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/app.ts", "domain/user")).toEqual({ resolved: "src/domain/user.ts" });
    expect(r.resolve("src/app.ts", "constants")).toEqual({ resolved: "src/constants.ts" });
    expect(r.resolve("src/app.ts", "events/x")).toEqual({ resolved: "src/events/x.ts" });
    expect(r.resolve("src/app.ts", "events")).toEqual({ external: true });
    expect(r.resolve("src/app.ts", "path")).toEqual({ external: true });
  });

  // Audit p3/p4: the index key must cover every config the resolver reads.
  it("lists every config and package.json it reads as inputs", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "app" }),
      "jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "web/tsconfig.json": JSON.stringify({
        extends: "../config/base.json",
        references: [{ path: "./tsconfig.app.json" }],
      }),
      "web/tsconfig.app.json": JSON.stringify({ compilerOptions: {} }),
      "config/base.json": JSON.stringify({ compilerOptions: {} }),
      "src/a.js": "",
      "web/b.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.inputsFor(["src/a.js", "web/b.ts"])).toEqual([
      "config/base.json",
      "jsconfig.json",
      "package.json",
      "web/tsconfig.app.json",
      "web/tsconfig.json",
    ]);
  });

  // Audit p5/p14: a workspace entry in lib/ (a build) won over src/, and a linked package
  // resolved to its dist/ output.
  it("prefers a package's source over its build output", async () => {
    const root = await project({
      "packages/util/package.json": JSON.stringify({ name: "@x/util", main: "lib/index.js" }),
      "packages/util/lib/index.js": "",
      "packages/util/src/index.ts": "export {};",
      "tools/x/package.json": JSON.stringify({ name: "x", types: "dist/index.d.ts" }),
      "tools/x/dist/index.d.ts": "export {};",
      "tools/x/dist/index.js": "",
      "tools/x/src/index.ts": "export {};",
      "src/a.ts": "",
    });
    await mkdir(join(root, "node_modules"));
    await symlink(join(root, "tools/x"), join(root, "node_modules/x"));
    const r = new TypeScriptResolver(root, [
      { name: "@x/util", dir: "packages/util", manifest: { main: "lib/index.js" } },
    ]);
    expect(r.resolve("src/a.ts", "@x/util")).toEqual({ resolved: "packages/util/src/index.ts" });
    expect(r.resolve("src/a.ts", "x")).toEqual({ resolved: "tools/x/src/index.ts" });
  });

  // Audit p6: the first referenced project that resolved won, whatever its include.
  it("resolves with the tsconfig project that includes the importing file", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.e2e.json" }],
      }),
      "tsconfig.app.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
        include: ["src"],
      }),
      "tsconfig.e2e.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["e2e/support/*"] } },
        include: ["e2e/**/*.ts"],
      }),
      "src/helpers.ts": "export {};",
      "e2e/support/helpers.ts": "export {};",
      "e2e/a.spec.ts": "",
      "src/a.ts": "",
      "scripts/x.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("e2e/a.spec.ts", "@/helpers")).toEqual({
      resolved: "e2e/support/helpers.ts",
    });
    expect(r.resolve("src/a.ts", "@/helpers")).toEqual({ resolved: "src/helpers.ts" });
    // No project includes the file and they disagree: kept, but uncertain.
    expect(r.resolve("scripts/x.ts", "@/helpers")).toEqual({
      resolved: "src/helpers.ts",
      uncertain: expect.stringContaining("no tsconfig project includes the file"),
    });
  });

  // Audit p11: only the first matching condition was used (`default`, never `browser`).
  it("reports export conditions naming different files as uncertain", async () => {
    const exports = { ".": { browser: "./src/browser.ts", default: "./src/node.ts" } };
    const root = await project({
      "packages/iso/package.json": JSON.stringify({ name: "iso", exports }),
      "packages/iso/src/browser.ts": "export {};",
      "packages/iso/src/node.ts": "export {};",
      "packages/one/src/index.ts": "export {};",
      "src/a.ts": "",
    });
    const r = new TypeScriptResolver(root, [
      { name: "iso", dir: "packages/iso", manifest: { exports } },
      {
        name: "one",
        dir: "packages/one",
        manifest: { exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } },
      },
    ]);
    expect(r.resolve("src/a.ts", "iso")).toEqual({
      resolved: "packages/iso/src/browser.ts",
      uncertain: expect.stringContaining("packages/iso/src/node.ts"),
    });
    // Conditions that map to the same source are no uncertainty.
    expect(r.resolve("src/a.ts", "one")).toEqual({ resolved: "packages/one/src/index.ts" });
  });

  // Audit p7: `#app` was always a framework module, and `imports` was ignored under
  // moduleResolution "node".
  it("resolves package.json imports whatever the moduleResolution", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        name: "app",
        imports: {
          "#app/*": "./src/*.ts",
          "#lib/*": "./src/lib/*",
          "#cfg": { node: "./src/cfg.ts" },
        },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "node" } }),
      "src/cfg.ts": "export {};",
      "src/lib/a.ts": "export {};",
      "src/main.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/main.ts", "#app/cfg")).toEqual({ resolved: "src/cfg.ts" });
    expect(r.resolve("src/main.ts", "#lib/a")).toEqual({ resolved: "src/lib/a.ts" });
    expect(r.resolve("src/main.ts", "#cfg")).toEqual({ resolved: "src/cfg.ts" });
    expect(r.resolve("src/main.ts", "#app/missing")).toMatchObject({ reason: expect.any(String) });
    // No Nuxt here: `#imports` is no framework module.
    expect(r.resolve("src/main.ts", "#imports")).toMatchObject({ reason: expect.any(String) });
  });

  it("treats framework modules as external only where the framework is", async () => {
    const root = await project({
      "app/main.wasp.ts": "",
      "app/src/a.ts": "",
      "nuxt/package.json": JSON.stringify({ devDependencies: { nuxt: "3" } }),
      "nuxt/a.ts": "",
      "plain/a.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("app/src/a.ts", "wasp/client/operations")).toEqual({ external: true });
    expect(r.resolve("nuxt/a.ts", "#imports")).toEqual({ external: true });
    expect(r.resolve("plain/a.ts", "wasp/client/operations")).toMatchObject({
      reason: expect.any(String),
    });
  });

  // Audit #10: a file outside the root can change without SmartTest seeing it.
  it("reports an import that resolves outside the project root as unresolved", async () => {
    const outer = await project({
      "shared/x.ts": "export {};",
      "app/src/a.ts": "",
      "app/package.json": JSON.stringify({ name: "app" }),
    });
    const r = new TypeScriptResolver(join(outer, "app"));
    expect(r.resolve("src/a.ts", "../../shared/x")).toMatchObject({
      reason: expect.stringContaining("outside the project root"),
    });
  });

  // Audit p8/p13: over-selection.
  it("resolves root-absolute imports from the Vite root, index.vue and aliased globs", async () => {
    const root = await project({
      "vite.config.ts": "",
      "src/pages/home.ts": "export {};",
      "src/main.ts": "",
      "src/w/index.vue": "",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/main.ts", "/src/pages/home")).toEqual({ resolved: "src/pages/home.ts" });
    expect(r.resolve("src/main.ts", "./w")).toEqual({ resolved: "src/w/index.vue" });
    expect(r.resolvePattern("src/main.ts", "@/pages/*.ts")).toBe("src/pages/*.ts");
    expect(r.resolvePattern("src/main.ts", "./pages/*.ts")).toBeUndefined();
  });

  it("resolves root-absolute glob patterns from the nearest Vite root", async () => {
    const root = await project({
      "apps/web/vite.config.ts": "export default {};",
      "apps/web/src/main.ts": "",
      "scripts/x.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolvePattern("apps/web/src/main.ts", "/src/pages/*.ts")).toBe(
      "apps/web/src/pages/*.ts",
    );
    expect(r.resolvePattern("scripts/x.ts", "/src/**/*.ts")).toBe("src/**/*.ts");
  });
});

describe("aliases only a bundler or test-runner config declares", () => {
  const pkg = JSON.stringify({ name: "app", dependencies: { vue: "3" } });

  it("Vite resolve.alias: object form, path.resolve / fileURLToPath / root-absolute targets", async () => {
    const root = await project({
      "package.json": pkg,
      "vite.config.ts": `import path from "node:path";
import { fileURLToPath } from "node:url";
export default {
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "~lib": fileURLToPath(new URL("./lib", import.meta.url)),
      "#ui": "/src/ui",
    },
  },
};`,
      "src/util/date.ts": "export {};",
      "src/ui/Button.ts": "export {};",
      "lib/index.ts": "export {};",
      "src/main.ts": "",
      "node_modules/vue/package.json": '{"name":"vue","main":"index.js"}',
      "node_modules/vue/index.js": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/main.ts", "@/util/date")).toEqual({ resolved: "src/util/date.ts" });
    expect(r.resolve("src/main.ts", "~lib")).toEqual({ resolved: "lib/index.ts" });
    expect(r.resolve("src/main.ts", "#ui/Button")).toEqual({ resolved: "src/ui/Button.ts" });
    // Not a prefix of another name: `@scope/pkg` and `~library` are no `@`/`~lib` alias.
    expect(r.resolve("src/main.ts", "~library").resolved).toBeUndefined();
    expect(r.resolve("src/main.ts", "vue")).toEqual({ external: true });
    // An alias that maps to no file stays unresolved, never external.
    expect(r.resolve("src/main.ts", "@/missing").reason).toMatch(/vite alias "@"/);
    expect(r.inputsFor(["src/main.ts"])).toContain("vite.config.ts");
    expect(r.resolvePattern("src/main.ts", "@/ui/*.ts")).toBe("src/ui/*.ts");
  });

  it("Vitest array form with regex finds, and aliases kept in a config the config imports", async () => {
    const root = await project({
      "package.json": pkg,
      "vitest.shared.ts": `import { resolve } from "node:path";
export const shared = { resolve: { alias: [{ find: /^~(.*)$/, replacement: resolve(__dirname, "src/$1") }] } };`,
      "vitest.config.ts": `import { mergeConfig } from "vitest/config";
import { shared } from "./vitest.shared";
export default mergeConfig(shared, { test: { alias: [{ find: "@test", replacement: "./test/support" }] } });`,
      "src/a.ts": "export {};",
      "test/support/index.ts": "export {};",
      "test/a.test.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("test/a.test.ts", "~a")).toEqual({ resolved: "src/a.ts" });
    expect(r.resolve("test/a.test.ts", "@test")).toEqual({ resolved: "test/support/index.ts" });
    expect(r.inputsFor(["test/a.test.ts"])).toEqual(
      expect.arrayContaining(["vitest.config.ts", "vitest.shared.ts"]),
    );
  });

  it("Jest moduleNameMapper: $1 captures, <rootDir>, directory targets, target lists", async () => {
    const root = await project({
      "package.json": pkg,
      "jest.config.js": `module.exports = {
  rootDir: ".",
  moduleNameMapper: {
    "^@app/(.*)$": "<rootDir>/src/$1",
    "^@shared$": ["<rootDir>/missing", "<rootDir>/shared"],
    "\\\\.(css)$": "identity-obj-proxy",
  },
};`,
      "src/x/y.ts": "export {};",
      "shared/index.js": "",
      "test/a.test.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("test/a.test.ts", "@app/x/y")).toEqual({ resolved: "src/x/y.ts" });
    expect(r.resolve("test/a.test.ts", "@shared")).toEqual({ resolved: "shared/index.js" });
  });

  it("Jest config in package.json, webpack `name$`, Babel module-resolver", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        name: "app",
        jest: { moduleNameMapper: { "^~/(.*)$": "<rootDir>/src/$1" } },
      }),
      "webpack.config.js": `const path = require("path");
module.exports = { resolve: { alias: { Utils$: path.resolve(__dirname, "src/utils/index.js"), Comp: path.join(__dirname, "src/components") } } };`,
      ".babelrc": JSON.stringify({
        plugins: [["module-resolver", { alias: { "^#(.+)": "./src/\\1", lib: "./lib" } }]],
      }),
      "src/utils/index.js": "",
      "src/utils/extra.js": "",
      "src/components/Btn.js": "",
      "src/hash.js": "",
      "lib/a.js": "",
      "src/main.js": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/main.js", "~/hash")).toEqual({ resolved: "src/hash.js" });
    expect(r.resolve("src/main.js", "Utils")).toEqual({ resolved: "src/utils/index.js" });
    expect(r.resolve("src/main.js", "Utils/extra").resolved).toBeUndefined();
    expect(r.resolve("src/main.js", "Comp/Btn")).toEqual({ resolved: "src/components/Btn.js" });
    expect(r.resolve("src/main.js", "#hash")).toEqual({ resolved: "src/hash.js" });
    expect(r.resolve("src/main.js", "lib/a")).toEqual({ resolved: "lib/a.js" });
  });

  it("app and test configs that map an import to different files keep it uncertain", async () => {
    const root = await project({
      "package.json": pkg,
      "vite.config.ts": `export default { resolve: { alias: { "@": "/src" } } };`,
      "jest.config.js": `module.exports = { moduleNameMapper: { "^@/(.*)$": "<rootDir>/test/fakes/$1" } };`,
      "src/api.ts": "export {};",
      "test/fakes/api.ts": "export {};",
      "src/main.ts": "",
    });
    const r = new TypeScriptResolver(root);
    const out = r.resolve("src/main.ts", "@/api");
    expect(out.resolved).toBe("src/api.ts");
    expect(out.uncertain).toMatch(/src\/api\.ts.*test\/fakes\/api\.ts/);
  });

  it("an alias set to a computed value stays unresolved", async () => {
    const root = await project({
      "package.json": pkg,
      "vite.config.ts": `const dirs = compute();
export default { resolve: { alias: dirs } };`,
      "src/a.ts": "export {};",
      "src/main.ts": "",
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/main.ts", "@/a").resolved).toBeUndefined();
    expect(r.resolve("src/main.ts", "@/a").external).toBeUndefined();
  });
});
