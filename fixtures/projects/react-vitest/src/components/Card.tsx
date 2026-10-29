import { Avatar } from "./Avatar";
import { Price } from "./Price";

export function Card({ name, cents }: { name: string; cents: number }) {
  return (
    <div className="card">
      <Avatar name={name} />
      <Price cents={cents} />
    </div>
  );
}
