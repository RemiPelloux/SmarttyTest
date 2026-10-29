import { expect, it } from "vitest";
import { CatalogService } from "../../../../src/modules/catalog/CatalogService";

it("sums product prices", () => {
  expect(new CatalogService().total()).toBe(42);
});
