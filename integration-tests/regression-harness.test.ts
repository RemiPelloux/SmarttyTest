/**
 * Regression-detection harness (ST-095, spec §11.7 / §32.4).
 * For every seeded mutation of every fixture: the tests expected to fail must be selected, and a
 * full reference run must show zero failures that the selection missed. CI fails otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, FIXTURES, materialize } from "./helpers.js";

interface Mutation {
  file: string;
  find: string;
  replace: string;
  expectFailing: string[];
}

const fixtures = [
  "nest-auth-vitest",
  "express-cjs-jest",
  "pnpm-monorepo",
  "node-test-esm",
  "edges-vitest",
  "ts-lib-vitest",
  "react-vitest",
  "yarn-workspaces-node",
  "next-playwright",
];

for (const fixture of fixtures) {
  const expected = JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8")) as {
    mutations: Mutation[];
  };
  describe(`regression harness · ${fixture}`, () => {
    for (const mode of ["balanced", "safe"] as const) {
      for (const m of expected.mutations) {
        it(`[${mode}] ${m.file}: ${m.find} → ${m.replace || "∅"}`, async () => {
          const dir = await materialize(fixture, { git: true });
          await edit(dir, m.file, m.find, m.replace);
          const st = await SmartTest.open({ root: dir });
          const v = await st.validateSelection({ mode });
          const selected = v.decision.selectedTests.map((t) => t.filePath);
          for (const t of m.expectFailing) expect(selected, `${t} must be selected`).toContain(t);
          expect(v.failuresMissed, "no reproducible failure may be missed").toEqual([]);
          expect(v.failuresFound.sort()).toEqual([...m.expectFailing].sort());
        }, 120_000);
      }
    }
  });
}
