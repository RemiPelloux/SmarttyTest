import { add, multiply } from "../../src/math.js";

describe("math", () => {
  it("adds", () => {
    expect(add(2, 3)).to.equal(5);
  });

  it("multiplies", () => {
    expect(multiply(2, 3)).to.equal(6);
  });

  it.skip("divides", () => {});
});
