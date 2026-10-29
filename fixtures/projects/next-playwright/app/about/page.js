import { slug } from "../../lib/format.js";

export default function page() {
  return `<h1>About</h1><p id="${slug("Our Team")}">team</p>`;
}
