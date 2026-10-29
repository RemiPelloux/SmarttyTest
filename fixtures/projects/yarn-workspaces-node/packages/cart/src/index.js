import { add } from "../../money/src/index.js";

export function total(items) {
  return items.reduce((sum, i) => add(sum, i.price), 0);
}
