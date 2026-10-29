const { total } = require("../src/billing/invoice");

test("totals line items", () => {
  expect(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }])).toBe(7);
});
