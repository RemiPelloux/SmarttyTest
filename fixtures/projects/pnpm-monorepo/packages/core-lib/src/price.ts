export const VAT = 0.2;

export function priceWithTax(net: number): number {
  return Math.round(net * (1 + VAT) * 100) / 100;
}
