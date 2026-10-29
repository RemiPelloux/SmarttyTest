export class Shop {
  price(n: number): number {
    return n * 10;
  }

  discount(n: number): number {
    return n > 2 ? 5 : 0;
  }
}

// The return type is not annotated, so callers see a value of unknown class (class-level edges).
export function makeShop() {
  return new Shop();
}
