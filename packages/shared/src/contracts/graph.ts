import type { Confidence, Provenance } from "../primitives.js";

export type GraphNodeKind =
  | "workspace"
  | "package"
  | "module"
  | "file"
  | "class"
  | "function"
  | "method"
  | "test-suite"
  | "test-case"
  | "configuration"
  | "external-dependency";

export type GraphEdgeKind =
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "REFERENCES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "INSTANTIATES"
  | "DEPENDS_ON"
  | "TESTS"
  | "COVERS"
  | "OBSERVED_EXECUTION"
  | "CONFIGURES";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  filePath?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  provenance: Provenance;
  confidence: Confidence;
}
