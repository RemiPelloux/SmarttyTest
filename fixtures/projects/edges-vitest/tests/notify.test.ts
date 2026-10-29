import { expect, it, vi } from "vitest";
import { notify } from "../src/notify";

vi.mock("../src/mailer");

it("notifies through the mailer mock", () => {
  expect(notify("ada")).toBe("mock sent to ada");
});
