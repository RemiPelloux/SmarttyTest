// @ts-expect-error resolved by the Vitest alias, not by TypeScript
import { darkMode } from "virtual:flags";

export function theme(): string {
  return darkMode ? "dark" : "light";
}
