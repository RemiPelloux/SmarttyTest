import { describe, expect, it } from "vitest";
import {
  lockEntries,
  lockfileDiff,
  manifestDiff,
  packageImpact,
  packageOfSpecifier,
  typedPackage,
  withDependents,
} from "./lockfiles.js";

const changed = (path: string, before: string, after: string) => {
  const d = lockfileDiff(path, before, after);
  if ("full" in d) throw new Error(d.full);
  return d;
};

describe("packageOfSpecifier", () => {
  it("names the package of a bare specifier", () => {
    expect(packageOfSpecifier("lodash/fp")).toBe("lodash");
    expect(packageOfSpecifier("@scope/pkg/sub/x")).toBe("@scope/pkg");
    expect(packageOfSpecifier("./local")).toBeUndefined();
    expect(packageOfSpecifier("node:fs")).toBeUndefined();
    expect(packageOfSpecifier("#internal")).toBeUndefined();
    expect(typedPackage("@types/scope__pkg")).toBe("@scope/pkg");
    expect(typedPackage("@types/react")).toBe("react");
  });
});

describe("npm", () => {
  const lock = (lodash: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "left-pad": "^1.0.0", wrapper: "^1" },
        },
        "node_modules/lodash": { version: lodash },
        "node_modules/wrapper": { version: "1.0.0", dependencies: { lodash: "^4" } },
        "node_modules/left-pad": { version: "1.3.0" },
        ...extra,
      },
    });
  it("finds the changed package and who depends on it", () => {
    const d = changed("package-lock.json", lock("4.17.20"), lock("4.17.21"));
    expect(d.packages).toEqual(["lodash"]);
    expect([...withDependents(d.packages, d.dependents)].sort()).toEqual(["lodash", "wrapper"]);
  });
  it("ignores the root's own version, but not a setting", () => {
    const a = lock("4.17.21");
    expect(
      changed(
        "package-lock.json",
        a,
        a.replace('"version":"1.0.0","lockfileVersion"', '"version":"2.0.0","lockfileVersion"'),
      ).packages,
    ).toEqual([]);
    const d = lockfileDiff(
      "package-lock.json",
      a,
      a.replace('"lockfileVersion":3', '"lockfileVersion":2'),
    );
    expect("full" in d && d.full).toContain("lockfileVersion");
  });
  it("reads lockfileVersion 1", () => {
    const v1 = (v: string) =>
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          wrapper: {
            version: "1.0.0",
            requires: { lodash: "^4" },
            dependencies: { lodash: { version: v } },
          },
        },
      });
    const d = changed("package-lock.json", v1("4.0.0"), v1("4.1.0"));
    expect(d.packages).toEqual(["lodash"]);
    expect(d.dependents.get("lodash")?.has("wrapper")).toBe(true);
  });
  it("is global when unreadable", () => {
    expect(lockfileDiff("package-lock.json", "{", "{}")).toEqual({
      full: "package-lock.json could not be read",
    });
  });
});

describe("yarn", () => {
  const classic = (v: string) => `# yarn lockfile v1


"@scope/wrapper@^1.0.0":
  version "1.0.0"
  dependencies:
    lodash "^4.17.0"

lodash@^4.17.0, lodash@^4.17.20:
  version "${v}"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-${v}.tgz"
`;
  it("classic", () => {
    const d = changed("yarn.lock", classic("4.17.20"), classic("4.17.21"));
    expect(d.packages).toEqual(["lodash"]);
    expect([...withDependents(d.packages, d.dependents)].sort()).toEqual([
      "@scope/wrapper",
      "lodash",
    ]);
  });
  const berry = (v: string, meta = "6") => `__metadata:
  version: ${meta}
  cacheKey: 8

"lodash@npm:^4.17.0":
  version: ${v}
  resolution: "lodash@npm:${v}"

"wrapper@npm:^1.0.0":
  version: 1.0.0
  dependencies:
    lodash: "npm:^4.17.0"
`;
  it("berry, with __metadata global", () => {
    const d = changed("yarn.lock", berry("4.17.20"), berry("4.17.21"));
    expect(d.packages).toEqual(["lodash"]);
    expect(d.dependents.get("lodash")?.has("wrapper")).toBe(true);
    expect(lockfileDiff("yarn.lock", berry("1"), berry("1", "7"))).toEqual({
      full: "yarn.lock: __metadata changed",
    });
  });
});

describe("pnpm", () => {
  const v9 = (react: string, settings = "false") => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: ${settings}

importers:

  .:
    dependencies:
      react-dom:
        specifier: ^18.0.0
        version: 18.2.0(react@${react})
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-a}

  react-dom@18.2.0:
    resolution: {integrity: sha512-b}
    peerDependencies:
      react: ^18.2.0

  react@${react}:
    resolution: {integrity: sha512-${react}}

snapshots:

  left-pad@1.3.0: {}

  '@scope/inline@1.0.0': {}

  react-dom@18.2.0(react@${react}):
    dependencies:
      react: ${react}
      scheduler: 0.23.0

  react@${react}: {}
`;
  it("v9: packages, snapshots and importers", () => {
    const d = changed("pnpm-lock.yaml", v9("18.2.0"), v9("18.3.0"));
    expect(d.packages).toEqual(["react", "react-dom"]);
    expect(d.dependents.get("react")?.has("react-dom")).toBe(true);
    expect(d.packages).not.toContain("left-pad");
    const keys = [...(lockEntries("pnpm-lock.yaml", v9("18.2.0"))?.values() ?? [])].flatMap(
      (e) => e.names,
    );
    expect(keys).toContain("@scope/inline");
    expect(keys.every((n) => !n.includes("'") && !n.includes(":"))).toBe(true);
  });
  it("a setting is global", () => {
    expect(lockfileDiff("pnpm-lock.yaml", v9("18.2.0"), v9("18.2.0", "true"))).toEqual({
      full: "pnpm-lock.yaml: settings changed",
    });
  });
  it("v6 and v5 keys", () => {
    const v6 = (v: string) => `lockfileVersion: '6.0'

dependencies:
  lodash:
    specifier: ^4
    version: ${v}

packages:

  /lodash@${v}:
    resolution: {integrity: sha512-x}
    dev: false

  /@scope/w@1.0.0:
    dependencies:
      lodash: ${v}
`;
    const d = changed("pnpm-lock.yaml", v6("4.17.20"), v6("4.17.21"));
    expect(d.packages).toEqual(["@scope/w", "lodash"]);
    const v5 = (v: string) => `lockfileVersion: 5.4

specifiers:
  lodash: ^4

dependencies:
  lodash: ${v}

packages:

  /lodash/${v}:
    resolution: {integrity: sha512-x}

  /@scope/w/1.0.0_lodash@${v}:
    dependencies:
      lodash: ${v}
`;
    expect(changed("pnpm-lock.yaml", v5("4.17.20"), v5("4.17.21")).packages).toEqual([
      "@scope/w",
      "lodash",
    ]);
  });
});

describe("manifestDiff", () => {
  const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: "app", ...o });
  it("dependency versions are packages, metadata is nothing, anything else is global", () => {
    const d = manifestDiff(
      "package.json",
      pkg({ dependencies: { a: "1" }, devDependencies: { b: "1" } }),
      pkg({ dependencies: { a: "2" }, devDependencies: { b: "1", c: "1" }, description: "x" }),
    );
    expect(d).toEqual({ packages: ["a", "c"], dependents: new Map() });
    expect(
      manifestDiff("package.json", pkg({ scripts: {} }), pkg({ scripts: { t: "x" } })),
    ).toEqual({
      full: 'package.json: "scripts" changed',
    });
  });
});

describe("packageImpact", () => {
  const base = {
    path: "yarn.lock",
    declared: new Set(["wrapper", "lodash", "left-pad", "vitest", "eslint-plugin-x"]),
    isConfig: (f: string) => f === "vitest.config.ts",
    texts: [] as { file: string; text: string }[],
  };
  const files = [
    { path: "src/a.ts", imports: [{ specifier: "wrapper" }] },
    { path: "src/b.ts", imports: [{ specifier: "lodash/fp" }] },
    { path: "src/c.ts", imports: [{ specifier: "left-pad" }] },
    { path: "src/react.ts", imports: [{ specifier: "react" }] },
  ];
  const diff = (packages: string[], deps: Record<string, string[]> = {}) => ({
    packages,
    dependents: new Map(Object.entries(deps).map(([k, v]) => [k, new Set(v)])),
  });
  it("selects the importers of a changed package and of the packages depending on it", () => {
    const r = packageImpact({ ...base, files, diff: diff(["lodash"], { lodash: ["wrapper"] }) });
    expect(r).toEqual({
      packages: ["lodash"],
      importers: [
        { file: "src/b.ts", package: "lodash" },
        { file: "src/a.ts", package: "wrapper" },
      ],
    });
  });
  it("a test tool selects everything, also through a dependency", () => {
    const r = packageImpact({ ...base, files, diff: diff(["tinypool"], { tinypool: ["vitest"] }) });
    expect("full" in r && r.full).toContain("vitest");
  });
  it("a declared package nothing imports selects everything, unless it is a lint tool", () => {
    const r = packageImpact({
      ...base,
      files,
      diff: diff(["dotenv-cli"]),
      declared: new Set(["dotenv-cli"]),
    });
    expect("full" in r && r.full).toContain("no analysed file imports it");
    expect(packageImpact({ ...base, files, diff: diff(["eslint-plugin-x"]) })).toEqual({
      packages: ["eslint-plugin-x"],
      importers: [],
    });
  });
  it("a package with nothing depending on it and no importer selects everything", () => {
    const r = packageImpact({ ...base, files, diff: diff(["orphan"]) });
    expect("full" in r).toBe(true);
  });
  it("a deep dependency with dependents needs no importer of its own", () => {
    const r = packageImpact({ ...base, files, diff: diff(["deep"], { deep: ["lodash"] }) });
    expect("importers" in r && r.importers.map((i) => i.file)).toEqual(["src/b.ts"]);
  });
  it("a config importing it, or a config or stylesheet naming it, selects everything", () => {
    const withConfig = [
      ...files,
      { path: "vitest.config.ts", imports: [{ specifier: "left-pad" }] },
    ];
    expect("full" in packageImpact({ ...base, files: withConfig, diff: diff(["left-pad"]) })).toBe(
      true,
    );
    const texts = [{ file: "src/styles.scss", text: '@use "left-pad/theme";' }];
    const r = packageImpact({ ...base, files, texts, diff: diff(["left-pad"]) });
    expect("full" in r && r.full).toContain("src/styles.scss names it");
  });
  it("@types packages map to the code importing the typed package", () => {
    const r = packageImpact({
      ...base,
      files,
      diff: diff(["@types/react"]),
      declared: new Set(["@types/react"]),
    });
    expect("importers" in r && r.importers).toEqual([
      { file: "src/react.ts", package: "@types/react" },
    ]);
  });
  it("a file with an import it cannot evaluate is an importer of every change", () => {
    const dyn = [
      ...files,
      { path: "src/plugins.ts", imports: [], dynamicUnresolved: ["require(name)"] },
    ];
    const r = packageImpact({ ...base, files: dyn, diff: diff(["left-pad"]) });
    expect("importers" in r && r.importers.map((i) => i.file)).toEqual([
      "src/c.ts",
      "src/plugins.ts",
    ]);
  });
});

describe("yarn workspaces", () => {
  const ws = (v: string, own = "0.0.0-use.local") => `__metadata:
  version: 8

"app@workspace:.":
  version: ${own}
  resolution: "app@workspace:."
  dependencies:
    left-pad: "npm:${v}"
    lodash: "npm:^4"

"left-pad@npm:${v}":
  version: ${v}
`;
  it("a workspace's dependency is its own entry, and the workspace depends on nothing", () => {
    const d = changed("yarn.lock", ws("1.3.0"), ws("1.3.1"));
    expect(d.packages).toEqual(["left-pad"]);
    expect(d.dependents.get("left-pad")).toBeUndefined();
    expect(changed("yarn.lock", ws("1.3.0"), ws("1.3.0", "1.0.0")).packages).toEqual([]);
  });
});

describe("found on opal-frontend", () => {
  it("a header listing several quoted descriptors names one package", () => {
    const lock = (v: string) => `__metadata:
  version: 8

"axios@npm:^1.0.0, axios@npm:^1.7.0":
  version: ${v}
`;
    expect(changed("yarn.lock", lock("1.7.0"), lock("1.8.0")).packages).toEqual(["axios"]);
  });
  it("a builder the test targets do not use is not a test tool", () => {
    const opts = {
      path: "yarn.lock",
      files: [{ path: "src/app.routes.ts", imports: [{ specifier: "@angular/router" }] }],
      declared: new Set(["@angular/router", "@angular-devkit/build-angular"]),
      isConfig: () => false,
      texts: [],
      diff: {
        packages: ["@angular/router"],
        dependents: new Map([["@angular/router", new Set(["@angular-devkit/build-angular"])]]),
      },
    };
    expect("full" in packageImpact(opts)).toBe(true);
    expect(
      packageImpact({ ...opts, notLoadedByTests: new Set(["@angular-devkit/build-angular"]) }),
    ).toEqual({
      packages: ["@angular/router"],
      importers: [{ file: "src/app.routes.ts", package: "@angular/router" }],
    });
  });
});

describe("tools only count when the tests can load them", () => {
  it("a tool reached only through an unused builder selects nothing more", () => {
    const r = packageImpact({
      path: "yarn.lock",
      files: [{ path: "src/api.ts", imports: [{ specifier: "axios" }] }],
      declared: new Set(["axios", "@angular-devkit/build-angular"]),
      isConfig: () => false,
      texts: [],
      notLoadedByTests: new Set(["@angular-devkit/build-angular"]),
      diff: {
        packages: ["shell-quote"],
        dependents: new Map([
          ["shell-quote", new Set(["launch-editor"])],
          ["launch-editor", new Set(["@angular-devkit/build-webpack"])],
          ["@angular-devkit/build-webpack", new Set(["@angular-devkit/build-angular"])],
        ]),
      },
    });
    expect(r).toEqual({ packages: ["shell-quote"], importers: [] });
  });
  it("the same tool reached from a used package selects everything, cycles included", () => {
    const r = packageImpact({
      path: "yarn.lock",
      files: [],
      declared: new Set(["app-tool"]),
      isConfig: () => false,
      texts: [],
      diff: {
        packages: ["a"],
        dependents: new Map([
          ["a", new Set(["b"])],
          ["b", new Set(["a", "vite"])],
          ["vite", new Set(["app-tool"])],
        ]),
      },
    });
    expect("full" in r && r.full).toContain("vite");
  });
});
