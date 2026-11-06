export function price(cents: number): number {
  return cents / 100;
}

export function discount(cents: number, pct: number): number {
  return Math.round(cents * (1 - pct / 100));
}
