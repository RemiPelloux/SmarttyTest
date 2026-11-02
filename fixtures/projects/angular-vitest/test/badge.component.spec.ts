import { expect, it } from "vitest";
import { BadgeComponent } from "../src/app/badge.component";
import { render } from "../src/app/core";

it("shows its label", () => {
  expect(render(BadgeComponent).html).toBe('<span class="badge">new</span>');
});
