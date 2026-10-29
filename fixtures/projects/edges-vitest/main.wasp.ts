import { getCount } from "./src/ops/getCount" with { type: "ref" };
import { getTotal } from "./src/ops/getTotal" with { type: "ref" };

export const operations = [
  { kind: "query", fn: getTotal },
  { kind: "query", fn: getCount },
];
