import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { Card } from "../src/components/Card";

it("renders a card", () => {
  const html = renderToString(<Card name="Ada Lovelace" cents={500} />);
  expect(html).toContain("€5.00");
  expect(html).toContain("AL");
});
