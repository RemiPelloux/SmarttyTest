import { displayName } from "../../lib/format.js";
import { USERS } from "../../lib/users.js";

export default function page() {
  return `<ul>${USERS.map((u) => `<li>${displayName(u)}</li>`).join("")}</ul>`;
}
