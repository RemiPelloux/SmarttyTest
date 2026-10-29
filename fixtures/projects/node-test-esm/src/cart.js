import { round } from "./money.js";

export function total(items) {
  return round(items.reduce((sum, i) => sum + i.price * i.qty, 0));
}
