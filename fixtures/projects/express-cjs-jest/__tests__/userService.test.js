const { getUser } = require("../src/services/userService");

test("returns a formatted user", () => {
  expect(getUser("1")).toEqual({ id: "1", name: "Ada Lovelace" });
});
