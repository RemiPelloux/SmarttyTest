export function getTotal(items: { price: number }[]): number {
  return items.reduce((sum, i) => sum + i.price, 0);
}
