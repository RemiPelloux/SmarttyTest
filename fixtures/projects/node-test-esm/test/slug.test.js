import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slug } from "../src/slug.js";

describe("slug", () => {
  it("lowercases and dashes", () => assert.equal(slug(" Hello World "), "hello-world"));
});
