import { expect, test } from "@playwright/test";
import { STATUS_PATH } from "../../lib/status.js";

test("reports its status", async ({ request }) => {
  expect(await (await request.get(STATUS_PATH)).json()).toEqual({ ok: true });
});
