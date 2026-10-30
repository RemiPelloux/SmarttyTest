import type { Protection } from "./protection.js";
import { lensTitle } from "./protection.js";

function code(value: string): string {
  const safe = value.replace(/`/g, "'");
  return `\`${safe}\``;
}

/**
 * Markdown for the hover. It repeats the CodeLens state rather than inventing
 * one, and always names the tests so the user can check the claim.
 */
export function hoverMarkdown(protection: Protection): string {
  const lines: string[] = [];
  lines.push(`**SmartTest — ${lensTitle(protection)}**`, "");
  lines.push(protection.reason, "");

  if (protection.testFiles.length > 0) {
    lines.push("Test files that reach this symbol:");
    for (const test of protection.testFiles.slice(0, 10)) {
      const path = protection.paths[test];
      const via = path && path.length > 1 ? ` (via ${path.slice(0, -1).join(" → ")})` : "";
      lines.push(`- ${code(test)}${via}`);
    }
    if (protection.testFiles.length > 10)
      lines.push(`- …and ${protection.testFiles.length - 10} more`);
    lines.push("");
  }

  if (protection.uncertainty.length > 0) {
    lines.push("**Uncertainty recorded by SmartTest:**");
    for (const entry of protection.uncertainty.slice(0, 5))
      lines.push(`- ${code(entry.file)}: ${entry.reasons.join("; ")}`);
    if (protection.uncertainty.length > 5)
      lines.push(`- …and ${protection.uncertainty.length - 5} more`);
    lines.push("");
  }

  lines.push(
    `Risk: ${code(protection.risk)} · Unit: ${code(protection.unitId)}`,
    "",
    "_A static graph can miss tests that reach this symbol through code it cannot resolve. SmartTest never treats an unknown as unprotected._",
  );
  return lines.join("\n");
}

export function explanationMarkdown(protection: Protection): string {
  return hoverMarkdown(protection);
}
