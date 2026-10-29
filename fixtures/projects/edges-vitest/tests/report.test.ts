import { expect, it, vi } from "vitest";
import { report } from "../src/report";

vi.mock("../src/stats", () => ({ mean: () => 42 }));

it("formats the report with a mocked mean", () => {
  expect(report([1])).toBe("mean=42");
});
