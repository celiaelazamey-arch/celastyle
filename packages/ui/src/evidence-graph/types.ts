/** Node state in the evidence graph. `idle` is distinct from `skip`:
 *  idle means "not evaluated yet", skip means "evaluated and not applicable". */
export type GraphNodeStatus = "idle" | "run" | "pass" | "fail" | "skip";

/** What a node represents. Determines its shape, not just its colour. */
export type GraphNodeKind =
  | "intent"
  | "constraint"
  | "gate"
  | "decision"
  | "deploy";

export type GraphNode = {
  id: string;
  label: string;
  /** Secondary line — the measurement or rule behind the node. */
  detail?: string;
  status: GraphNodeStatus;
  kind: GraphNodeKind;
  /** Which column the node sits in. 0 is the leftmost. */
  layer: number;
  /** Position within its column. Defaults to declaration order. */
  order?: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  /** Optional emphasis — a violated path is drawn heavier. */
  violated?: boolean;
};

export type EvidenceGraphProps = {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** Called when a node is selected. */
  onSelect?: (nodeId: string) => void;
  /** Currently selected node. */
  selectedId?: string | null;
  /** Accessible name for the graphic. */
  label?: string;
  className?: string;
};
