import { describe, expect, it } from "vitest";
import { CypressAdapter } from "./index.js";

const junit = (file?: string) =>
  `<testsuites><testsuite name="Root Suite"${file ? ` file="${file}"` : ""}></testsuite></testsuites>`;

describe("crediting a Cypress JUnit file to a spec", () => {
  const adapter = new CypressAdapter({ projectRoot: "/p", cwd: "/p/web" });
  const selected = ["web/cypress/e2e/a.cy.js", "web/cypress/e2e/ba.cy.js"];

  it("never credits a file without a `file` attribute to a spec when several ran", () => {
    expect(adapter.specOfJUnit(junit(), selected)).toBe("(unattributed)");
    expect(adapter.specOfJUnit(junit(), ["web/cypress/e2e/a.cy.js"])).toBe(
      "web/cypress/e2e/a.cy.js",
    );
  });

  it("matches the attribute on a path boundary, never on a bare suffix", () => {
    expect(adapter.specOfJUnit(junit("cypress/e2e/a.cy.js"), selected)).toBe(
      "web/cypress/e2e/a.cy.js",
    );
    expect(adapter.specOfJUnit(junit("cypress/e2e/ba.cy.js"), selected)).toBe(
      "web/cypress/e2e/ba.cy.js",
    );
    expect(adapter.specOfJUnit(junit("/p/web/cypress/e2e/a.cy.js"), selected)).toBe(
      "web/cypress/e2e/a.cy.js",
    );
    // `a.cy.js` is a suffix of `ba.cy.js`, but not on a path boundary.
    expect(adapter.specOfJUnit(junit("a.cy.js"), ["web/cypress/e2e/ba.cy.js"])).toBe("a.cy.js");
  });
});
