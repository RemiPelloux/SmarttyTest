import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { Price } from "../src/components/Price";

it("renders euros", () => expect(renderToString(<Price cents={1250} />)).toContain("€12.50"));
