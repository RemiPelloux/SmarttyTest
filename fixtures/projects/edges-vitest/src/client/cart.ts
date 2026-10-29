import { getCount, getTotal } from "wasp/client/operations";

export function cartLabel(items: { price: number }[]): string {
  return `${getTotal(items)} EUR`;
}

export function badge(items: unknown[]): string {
  return `${getCount(items)}`;
}
