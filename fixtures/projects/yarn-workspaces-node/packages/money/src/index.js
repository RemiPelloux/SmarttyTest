export function add(a, b) {
  return Math.round((a + b) * 100) / 100;
}

export function format(n) {
  return `${n.toFixed(2)} EUR`;
}
