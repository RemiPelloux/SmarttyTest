import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Signs in to the deployed environment before the `live` project runs.
test("live setup", async ({ request }) => {
  if (process.env.SETUP_LOG) appendFileSync(process.env.SETUP_LOG, "live-setup\n");
  expect((await request.get("/api/status")).ok()).toBe(true);
});
