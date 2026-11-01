import { expect, it } from "vitest";
import { square } from "../src/squares";

it("squares in a worker thread", async () => {
  expect(await square(3)).toBe(9);
});
