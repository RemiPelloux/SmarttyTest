import { expect, it } from "vitest";
import { featureOn } from "../src/config";

it("has the feature on", () => {
  expect(featureOn()).toBe(true);
});
