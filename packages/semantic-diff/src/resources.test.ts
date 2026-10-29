import { describe, expect, it } from "vitest";
import { diffCatalog, diffResource, isEnvFile, parseEnv, prismaBlocks } from "./resources.js";

const LOCALES = /(^|\/)locales\//;

describe("resource diffs", () => {
  it("recognises env files but not documentation copies", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("app/.env.server")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
  });

  it("diffs env keys", () => {
    expect([...parseEnv("# c\nA=1\nexport B = two\n").entries()]).toEqual([
      ["A", "1"],
      ["B", "two"],
    ]);
    expect(diffResource(".env.test", "A=1\nB=2\n", "A=1\nB=3\nC=4\n", LOCALES)).toEqual({
      file: ".env.test",
      kind: "env",
      keys: ["B", "C"],
      global: false,
    });
  });

  it("diffs Prisma models and flags datasource changes as global", () => {
    const before =
      'datasource db {\n provider = "postgresql"\n}\nmodel User {\n id Int @id\n}\nenum Role {\n A\n}\n';
    expect([...prismaBlocks(before).keys()]).toEqual([
      "other:datasource db",
      "model:User",
      "model:Role",
    ]);
    const r = diffResource(
      "schema.prisma",
      before,
      before.replace("id Int @id", "id Int @id\n name String"),
      LOCALES,
    );
    expect(r).toMatchObject({ kind: "model", keys: ["User"], global: false });
    const g = diffResource("schema.prisma", before, before.replace("postgresql", "mysql"), LOCALES);
    expect(g).toMatchObject({ keys: [], global: true });
  });

  it("diffs translation keys with their namespace", () => {
    expect(
      diffCatalog(
        "src/locales/en/auth.ts",
        { "login.title": "a", x: "b" },
        { "login.title": "c", x: "b" },
      ).keys,
    ).toEqual(["auth.login.title"]);
    expect(
      diffResource("locales/en.json", '{"a":{"b":"x"}}', '{"a":{"b":"y"}}', LOCALES)?.keys,
    ).toEqual(["a.b"]);
  });
});
