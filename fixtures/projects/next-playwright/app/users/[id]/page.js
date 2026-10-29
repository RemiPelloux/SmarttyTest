import { displayName } from "../../../lib/format.js";
import { findUser } from "../../../lib/users.js";

export default function page({ id }) {
  const user = findUser(id);
  return user ? `<h1>${displayName(user)}</h1>` : "<h1>Not found</h1>";
}
