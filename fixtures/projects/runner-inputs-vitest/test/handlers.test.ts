import { expect, it } from "vitest";

// The setup file installs the mock handlers; this test imports nothing from src/.
it("sees the handlers the setup file installs", () => {
  expect((globalThis as { handlers?: { user: string } }).handlers?.user).toBe("alice");
});
