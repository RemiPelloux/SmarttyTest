import { defineConfig } from "vitest/config";

// Stand-in for Angular's compiler (and Analog's Vitest plugin): component resources named by path
// (`templateUrl`, `styleUrl`) are inlined at build time, relative to the component's own file.
const RESOURCE = /(templateUrl|styleUrl)\s*:\s*["']([^"']+)["']/g;

export default defineConfig({
  plugins: [
    {
      name: "inline-component-resources",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".component.ts")) return undefined;
        const imports: string[] = [];
        const out = code.replace(RESOURCE, (_m, key: string, path: string) => {
          const name = `__resource${imports.length}`;
          imports.push(`import ${name} from ${JSON.stringify(`${path}?${key === "styleUrl" ? "inline" : "raw"}`)};`);
          return key === "templateUrl" ? `template: ${name}` : `styles: [${name}]`;
        });
        return imports.length ? `${imports.join("\n")}\n${out}` : undefined;
      },
    },
  ],
  // Component styles are processed (and their `@import`s inlined), as Angular's builder does.
  test: { css: true },
});
