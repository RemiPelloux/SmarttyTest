// A barrel with code that runs when it loads: it reads every plugin it re-exports.
import { alpha } from "./alpha";
import { beta } from "./beta";

export { alpha, beta };

export const registry: Record<string, () => string> = {};
for (const plugin of [alpha, beta]) registry[plugin.name] = plugin;
