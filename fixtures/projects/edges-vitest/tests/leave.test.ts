import { expect, it } from "vitest";
import { leave } from "../src/greet";

it("says goodbye", () => {
  expect(leave("Ada")).toBe("Bye, Ada");
});
