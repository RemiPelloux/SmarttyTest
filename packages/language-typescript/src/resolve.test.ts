import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("reports a bare import that is no alias and no installed package as unresolved", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/a.ts": "export {};",
      "node_modules/real-pkg/package.json": JSON.stringify({ name: "real-pkg", main: "index.js" }),
      "node_modules/real-pkg/index.js": "",
      "node_modules/.pnpm/node_modules/@scope/stored/package.json": JSON.stringify({
        name: "@scope/stored",
      }),
    });
    const r = new TypeScriptResolver(root);
    expect(r.resolve("src/a.ts", "@hooks/useThing")).toEqual({
      reason: '"@hooks/useThing" is neither a path alias nor an installed package',
    });
    expect(r.resolve("src/a.ts", "real-pkg")).toEqual({ external: true });
    expect(r.resolve("src/a.ts", "@scope/stored/sub")).toEqual({ external: true });
    expect(r.resolve("src/a.ts", "node:fs")).toEqual({ external: true });
  });
});
