import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function shortHash(data: string | Uint8Array, length = 12): string {
  return sha256(data).slice(0, length);
}
