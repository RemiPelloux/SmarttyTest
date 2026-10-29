import { expect, it } from "vitest";
import { apiUrl } from "../src/config";

it("reads the API url", () => {
  expect(apiUrl()).toBe("https://api.test");
});
