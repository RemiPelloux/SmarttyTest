import { expect, it } from "vitest";
import { Labeler } from "../src/index";

it("labels and caches", () => {
  const l = new Labeler();
  expect(l.label("ada")).toBe("Ada");
  expect(l.label("ada")).toBe("Ada");
});
