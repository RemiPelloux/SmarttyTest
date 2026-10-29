import { formatEuro } from "@demo/core-lib";

export function banner(amount: number): string {
  return `Only ${formatEuro(amount)} today`;
}
