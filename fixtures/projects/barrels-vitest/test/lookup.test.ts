import { expect, it } from "vitest";
import * as shop from "../src";

// A member read by a computed name: which export runs is decided at run time.
const name = ["pr", "ice"].join("") as "price";

it("looks a function up by name", () => expect(shop[name](100)).toBe(1));
