const { handle } = require("../src/app");

test("routes /users", () => {
  expect(handle("/users/1", { params: { id: "1" } }).name).toBe("Ada Lovelace");
});

test("unknown routes return null", () => {
  expect(handle("/nope", {})).toBeNull();
});
