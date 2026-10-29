import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { Avatar } from "../src/components/Avatar";

it("renders initials", () => expect(renderToString(<Avatar name="Ada Lovelace" />)).toContain("AL"));
