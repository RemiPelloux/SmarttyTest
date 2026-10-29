import { initials } from "../format";

export function Avatar({ name }: { name: string }) {
  return <span className="avatar">{initials(name)}</span>;
}
