import { priceWithTax } from "@demo/core-lib";

export function checkoutTotal(items: number[]): number {
  return items.reduce((sum, net) => sum + priceWithTax(net), 0);
}
