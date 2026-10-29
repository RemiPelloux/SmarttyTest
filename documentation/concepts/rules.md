# Rules

Rules turn your architecture into testing policy. They are deterministic, inspectable and kept as code.

```ts
// smarttest.config.ts
import { defineConfig } from "smarttest";

export default defineConfig({
  rules: [
    {
      name: "service-tests",
      match: { class: "*Service" },
      require: ["unit"],
      coverage: { lines: 90, branches: 85 },
      generate: { template: "service" },
    },
    {
      name: "repository-tests",
      match: { class: "*Repository" },
      require: ["unit", "integration"],
      generate: { template: "database" },
    },
    {
      name: "authentication-critical",
      match: { path: "src/modules/auth/**" },
      risk: "critical",
      execution: { alwaysRunOnAffected: true, mode: "safe" },
    },
  ],
});
```

## Selectors (1.0)

`path` (glob) · `package` · `class` · `function` · `method` · `decorator` · `visibility` · `kind` · `implements` / `extends`. Multiple selectors in one rule are combined with AND.

## Effects

| Field       | Effect                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `require`   | Required test categories (`unit`, `integration`, `e2e`). Missing ones are reported as policy findings |
| `coverage`  | Thresholds, evaluated when coverage is available, otherwise reported as _not evaluated_               |
| `risk`      | `low                                                                                                  | medium | high | critical`. Critical upgrades the mode to SAFE for affected areas |
| `execution` | `alwaysRunOnAffected`, `mode`, `retries`                                                              |
| `generate`  | Template and path template for the generator                                                          |

## Precedence

1. Built-in safeguards (mandatory triggers) always apply and cannot be weakened.
2. Matching rules are ordered by specificity: method (6) > function (5) > class / decorator / extends / implements (4) > exact file path (3.5) > visibility / kind (3) > path glob (2.x, deeper prefixes first) > package (1). Ties keep declaration order.
3. Safety fields are never weakened by a more specific rule: `risk` is the maximum, `execution.mode` the strictest, `alwaysRunOnAffected` an OR. `risk: critical` implies mode `safe`.
4. `require` lists are merged. Scalars such as `retries` and `generate` come from the most specific rule.
5. Two equally specific rules with different generation targets raise `ST_RULE_CONFLICT` (exit 3).

```bash
smarttest rules list
smarttest rules validate
smarttest rules explain src/modules/auth/AuthService.ts
```
