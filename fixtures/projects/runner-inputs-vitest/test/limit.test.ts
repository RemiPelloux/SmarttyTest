import { expect, it } from "vitest";
import { limit } from "../src/limit";

it("reads the limit the shared configuration defines", () => expect(limit()).toBe(3));
