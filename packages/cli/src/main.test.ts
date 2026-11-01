import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, openCommand } from "./main.js";

describe("opening a report (SR-09)", () => {
  it("never starts cmd.exe, which would run `&` in a path as a command", () => {
    const path = "C:\\work\\R&D\\x&calc&\\report.html";
    expect(openCommand(path, "win32")).toEqual(["explorer.exe", [path]]);
    expect(openCommand("/a/report.html", "darwin")).toEqual(["open", ["/a/report.html"]]);
    expect(openCommand("/a/report.html", "linux")).toEqual(["xdg-open", ["/a/report.html"]]);
  });
});

describe("terminal output (SR-07)", () => {
  it("strips escape sequences that repository content puts into messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-cli-esc-"));
    try {
      // An unknown key is echoed back as a warning: the key is repository content.
      await writeFile(
        join(dir, "smarttest.config.json"),
        JSON.stringify({ "x\u001b]52;c;Y3VybCBldmls\u0007\u001b[2Ay": 1 }),
      );
      let out = "";
      let err = "";
      const io = {
        stdout: { write: (s: string) => (out += s), isTTY: false },
        stderr: { write: (s: string) => (err += s), isTTY: false },
      };
      await main(["scan"], io, dir);
      await main(["scan", "--config", "missing\u001b]0;title\u0007.json"], io, dir);
      expect(err).toContain("config xy");
      expect(err).toContain("missing.json");
      for (const raw of ["\u001b]", "\u001b[2A", "\u0007"])
        expect(`${out}${err}`).not.toContain(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
