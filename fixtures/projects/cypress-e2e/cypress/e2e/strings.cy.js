import { shout } from "../../src/strings.js";

describe("strings", () => {
  it("shouts", () => {
    expect(shout("hi")).to.equal("HI!");
  });
});
