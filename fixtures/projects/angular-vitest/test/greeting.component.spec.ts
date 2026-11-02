import { expect, it } from "vitest";
import { render } from "../src/app/core";
import { GreetingComponent } from "../src/app/greeting.component";

it("greets by name", () => {
  expect(render(GreetingComponent).html).toBe('<p class="greeting">Hello Ada</p>');
});

it("uses the brand colour from the design tokens", () => {
  expect(render(GreetingComponent).styles).toContain("--brand: #c00");
});
