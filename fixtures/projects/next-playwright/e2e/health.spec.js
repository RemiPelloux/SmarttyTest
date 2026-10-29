import { expect, test } from "@playwright/test";

test("health endpoint", async ({ request }) => {
  expect(await (await request.get("/api/health")).json()).toEqual({ ok: true });
});
