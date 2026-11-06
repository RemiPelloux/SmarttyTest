import { appendFileSync } from "node:fs";
import { test } from "@playwright/test";

// The setup project the `local` project depends on. Each run appends a line to SETUP_LOG, so a
// test can count how many times it ran.
test("local setup", () => {
  if (process.env.SETUP_LOG) appendFileSync(process.env.SETUP_LOG, "local-setup\n");
});
