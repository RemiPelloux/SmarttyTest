export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function percent(n: number): string {
  return `${n}%`;
}
