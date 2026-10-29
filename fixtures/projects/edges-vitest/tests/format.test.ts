import { expect, it } from "vitest";
import { shout } from "../src/format";

it("shouts", () => {
  expect(shout("hi")).toMatchSnapshot();
});
