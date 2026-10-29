import type { SourceRange } from "../primitives.js";

export type SymbolKind =
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "property"
  | "type";

export interface SourceSymbol {
  id: string;
  filePath: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature?: string;
  sourceRange: SourceRange;
  parentSymbolId?: string;
  visibility?: "public" | "protected" | "private";
  decorators: string[];
  dependencies: string[];
}

export type SemanticChangeKind =
  | "comment-only"
  | "formatting"
  | "implementation"
  | "signature"
  | "exported-api"
  | "interface"
  | "inheritance"
  | "decorator"
  | "import"
  | "configuration"
  | "potential-behavioral"
  | "unclassifiable";

export interface SemanticChange {
  symbolId?: string;
  filePath: string;
  kind: SemanticChangeKind;
  /** Classification must report uncertainty (spec §9.4). */
  confidence: "high" | "medium" | "low";
  notes?: string;
}
