export const price = (cents: number) => `€${(cents / 100).toFixed(2)}`;
export const initials = (name: string) =>
  name
    .split(" ")
    .map((p) => p[0])
    .join("");
