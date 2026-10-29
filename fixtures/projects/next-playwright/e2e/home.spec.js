import { expect, test } from "@playwright/test";

test("home page", async ({ request }) => {
  const res = await request.get("/");
  expect(await res.text()).toContain("<h1>Home</h1>");
});
