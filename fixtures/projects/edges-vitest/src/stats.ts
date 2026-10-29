export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
