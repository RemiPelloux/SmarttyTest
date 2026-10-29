import { price } from "../format";

export function Price({ cents }: { cents: number }) {
  return <span className="price">{price(cents)}</span>;
}
