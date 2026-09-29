import type { GraphEdge, GraphNode } from "./types";

/* =============================================================================
   Layered graph layout
   -----------------------------------------------------------------------------
   A general DAG layout is a research problem (Sugiyama and friends), and a
   force simulation is worse than useless here: an evidence graph is *known* to
   be layered — intent leads to constraints, constraints gate on checks, checks
   decide, decisions deploy. Rendering that structure is honest and readable;
   animating it into position with physics would be slower and less legible.

   So the layout is deterministic: one column per layer, nodes stacked within
   it, each column vertically centred against the tallest. Deterministic also
   means testable — this function returns numbers, and a render test can assert
   on them.
   ========================================================================== */

export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 54;
export const LAYER_GAP = 76;
export const NODE_GAP = 14;

export type PositionedNode = GraphNode & {
  x: number;
  y: number;
  /** Set when the node is the last in its column — the guide rail stops. */
  lastInColumn: boolean;
};

export type Layout = {
  nodes: PositionedNode[];
  edges: (GraphEdge & { path: string })[];
  width: number;
  height: number;
  /** Column count, so the UI can render a legend aligned to it. */
  columns: number;
};

export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Layout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, columns: 0 };
  }

  // Group by layer, then by declared order within the layer.
  const columns = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const column = columns.get(node.layer);
    if (column) column.push(node);
    else columns.set(node.layer, [node]);
  }
  for (const column of columns.values()) {
    column.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  const layerIndexes = [...columns.keys()].sort((a, b) => a - b);
  const columnCount = layerIndexes.length;

  const tallest = Math.max(
    ...layerIndexes.map((layer) => columns.get(layer)!.length),
  );
  const contentHeight =
    tallest * NODE_HEIGHT + Math.max(0, tallest - 1) * NODE_GAP;

  const positioned: PositionedNode[] = [];

  layerIndexes.forEach((layer, columnIndex) => {
    const column = columns.get(layer)!;
    const columnHeight =
      column.length * NODE_HEIGHT + Math.max(0, column.length - 1) * NODE_GAP;
    // Centre this column against the tallest one, so the graph reads as a
    // left-to-right flow rather than as a ragged block.
    const top = (contentHeight - columnHeight) / 2;

    column.forEach((node, rowIndex) => {
      positioned.push({
        ...node,
        x: columnIndex * (NODE_WIDTH + LAYER_GAP),
        y: top + rowIndex * (NODE_HEIGHT + NODE_GAP),
        lastInColumn: rowIndex === column.length - 1,
      });
    });
  });

  const byId = new Map(positioned.map((n) => [n.id, n]));

  const laidOutEdges = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    // An edge to a node that was filtered out is dropped rather than drawn to
    // a dangling endpoint.
    if (!from || !to) return [];

    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    // Control points at the midpoint give a smooth S-curve; a straight line
    // reads as a connection to the wrong node when rows differ.
    const dx = Math.max(24, (x2 - x1) / 2);

    return [
      {
        ...edge,
        path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      },
    ];
  });

  return {
    nodes: positioned,
    edges: laidOutEdges,
    width: columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * LAYER_GAP,
    height: contentHeight,
    columns: columnCount,
  };
}
