import { expect, test } from "@playwright/test";
import { GREETING_PATH } from "../../lib/greeting.js";

test("greets by name", async ({ request }) => {
  const res = await request.get(`${GREETING_PATH}?name=Ada`);
  expect(await res.json()).toEqual({ text: "Hello, Ada" });
});
