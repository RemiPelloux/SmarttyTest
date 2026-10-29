const { formatName, slug } = require("../src/utils/format");

test("formats names", () => {
  expect(formatName({ first: "Ada", last: "Lovelace" })).toBe("Ada Lovelace");
});

test("slugs text", () => {
  expect(slug("Hello World")).toBe("hello-world");
});
