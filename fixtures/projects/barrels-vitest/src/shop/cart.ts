export function total(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0);
}

export function count(items: number[]): number {
  return items.length;
}
