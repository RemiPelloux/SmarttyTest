import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "@smarttest/config";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "./plugins.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const PLUGIN = 'export default { apiVersion: 1, name: "p", edgeProviders: [] };\n';

describe("plugin paths stay inside the project (SR-17)", () => {
  it("loads a plugin file of the project and refuses one outside it", async () => {
    const base = await mkdtemp(join(tmpdir(), "st-plugins-"));
    dirs.push(base);
    const root = join(base, "repo");
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "tools", "ok.mjs"), PLUGIN);
    await writeFile(join(base, "outside.mjs"), PLUGIN);
    await symlink(join(base, "outside.mjs"), join(root, "tools", "linked.mjs"));

    expect((await loadPlugins(root, ["./tools/ok.mjs"])).map((p) => p.plugin.name)).toEqual(["p"]);
    for (const spec of ["../outside.mjs", join(base, "outside.mjs"), "./tools/linked.mjs"])
      await expect(loadPlugins(root, [spec]), spec).rejects.toMatchObject({
        code: "ST_PLUGIN_OUTSIDE_PROJECT",
      });
  });

  it("refuses absolute and ../ plugin paths in the configuration", () => {
    const errors = (plugins: string[]) => validateConfig({ plugins }).errors.map((e) => e.path);
    expect(errors(["../evil.mjs", "/tmp/evil.mjs", "./tools/ok.mjs", "some-package"])).toEqual([
      "plugins[0]",
      "plugins[1]",
    ]);
  });
});
