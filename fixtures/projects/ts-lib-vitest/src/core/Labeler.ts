import { capitalize } from "@lib/util";
import { Cache } from "./Cache";

export class Labeler {
  private readonly cache = new Cache<string>();

  label(name: string): string {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const out = capitalize(name);
    this.cache.set(name, out);
    return out;
  }
}
