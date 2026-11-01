import { describe, expect, it } from "vitest";
import { catArgs, HgAdapter } from "./index.js";

describe("hg file reads (SR-05)", () => {
  it("never lets a file name be read as an option or a pattern", () => {
    expect(catArgs("abc123", "--config=alias.cat=!touch pwned")).toEqual([
      "cat",
      "-r",
      "abc123",
      "--",
      "path:--config=alias.cat=!touch pwned",
    ]);
    expect(catArgs("abc123", "src/*.ts").at(-1)).toBe("path:src/*.ts");
  });

  it("refuses an option-like base revision before running hg", async () => {
    await expect(new HgAdapter(process.cwd()).resolveBase("--config=x=y")).rejects.toMatchObject({
      code: "ST_UNSAFE_REVISION",
    });
  });
});
