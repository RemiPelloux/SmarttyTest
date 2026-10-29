import { expect, test } from "@playwright/test";

test("about page", async ({ request }) => {
  expect(await (await request.get("/about")).text()).toContain('id="our-team"');
});
