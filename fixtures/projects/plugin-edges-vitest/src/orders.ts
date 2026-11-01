import { query } from "./db.js";

export function listOrdersQuery(): string {
  return query("list-orders");
}

export function orderCount(rows: unknown[]): number {
  return rows.length;
}
