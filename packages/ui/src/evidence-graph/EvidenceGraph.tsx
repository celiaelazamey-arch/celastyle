"use client";

import { useMemo, useState } from "react";
import type {
  EvidenceGraphProps,
  GraphNodeKind,
  GraphNodeStatus,
} from "./types";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./layout";

/* Per-status and per-kind presentation. Both resolve to token variables —
   no literal colour appears in this component, so the graph re-themes with
   the rest of the system. */
const STATUS_CLASS: Record<GraphNodeStatus, string> = {
  idle: "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-muted)]",
  run: "border-[var(--accent-lime)] bg-[var(--accent-lime-alpha-10)] text-[var(--text-primary)]",
  pass: "border-[var(--status-pass-alpha-30)] bg-[var(--status-pass-alpha-10)] text-[var(--text-primary)]",
  fail: "border-[var(--status-fail)] bg-[var(--status-fail-alpha-10)] text-[var(--text-primary)]",
  skip: "border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-muted)]",
};

const KIND_MARK: Record<GraphNodeKind, string> = {
  intent: "◆",
  constraint: "▣",
  gate: "✓",
  decision: "◈",
  deploy: "⬢",
};

/** Status word announced to assistive tech. The coloured mark is decorative. */
const STATUS_WORD: Record<GraphNodeStatus, string> = {
  idle: "not evaluated",
  run: "running",
  pass: "passed",
  fail: "failed",
  skip: "skipped",
};

export function EvidenceGraph({
  nodes,
  edges,
  onSelect,
  selectedId = null,
  label = "Evidence graph",
  className,
}: EvidenceGraphProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);

  // Edges incident to the hovered or selected node are emphasised; the rest
  // recede. Recomputing this per hover is fine — the graph is small, and it is
  // what makes the structure readable when there are many branches.
  const focus = hovered ?? selectedId;
  const activeEdges = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>();
    for (const edge of edges) {
      if (edge.from === focus) set.add(`${edge.from}->${edge.to}`);
      if (edge.to === focus) set.add(`${edge.from}->${edge.to}`);
    }
    return set;
  }, [edges, focus]);

  if (layout.columns === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] p-8 font-mono text-xs text-[var(--text-muted)] ${className ?? ""}`}
      >
        no evidence to graph
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="sr-only">{label}</p>
      {/* The canvas scrolls horizontally rather than scaling: a scaled graph
          shrinks its own text below a readable size on a narrow window. */}
      <div className="celastyle-scroll overflow-x-auto pb-2">
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height }}
        >
          {/* Edges sit behind the nodes and are decorative — the node buttons
              carry the semantics, so the SVG is hidden from AT. */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              <marker
                id="cs-graph-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--border-strong)" />
              </marker>
              <marker
                id="cs-graph-arrow-active"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 1 L 7 4 L 0 7 z"
                  fill="var(--accent-lime)"
                />
              </marker>
            </defs>

            {layout.edges.map((edge) => {
              const isActive = activeEdges?.has(`${edge.from}->${edge.to}`);
              const dim = activeEdges !== null && !isActive;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={edge.path}
                  fill="none"
                  markerEnd={
                    isActive
                      ? "url(#cs-graph-arrow-active)"
                      : "url(#cs-graph-arrow)"
                  }
                  className="transition-opacity"
                  style={{
                    opacity: dim ? 0.18 : 1,
                    stroke: isActive
                      ? "var(--accent-lime)"
                      : edge.violated
                        ? "var(--status-fail)"
                        : "var(--border-strong)",
                    strokeWidth: isActive || edge.violated ? 2 : 1.25,
                  }}
                />
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            const isSelected = node.id === selectedId;
            const isHovered = node.id === hovered;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect?.(node.id)}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.id)}
                onBlur={() => setHovered(null)}
                aria-pressed={isSelected}
                data-node={node.id}
                data-status={node.status}
                data-kind={node.kind}
                className={`absolute flex flex-col justify-center gap-0.5 rounded-lg border px-3 text-left transition-[border-color,box-shadow] ${STATUS_CLASS[node.status]} ${
                  isSelected || isHovered
                    ? "shadow-[0_0_0_1px_var(--accent-lime)]"
                    : ""
                }`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`shrink-0 text-[10px] leading-none ${
                      node.status === "run"
                        ? "animate-pulse text-[var(--accent-lime)]"
                        : "text-[var(--text-dim)]"
                    }`}
                  >
                    {KIND_MARK[node.kind]}
                  </span>
                  <span className="truncate text-[11px] font-semibold">
                    {node.label}
                  </span>
                </span>
                {node.detail ? (
                  <span className="truncate pl-[18px] font-mono text-[10px] text-[var(--text-dim)]">
                    {node.detail}
                  </span>
                ) : null}
                {/* The glyph and colour above are decoration; this is what
                    actually reaches a screen reader. */}
                <span className="sr-only">{STATUS_WORD[node.status]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <GraphLegend />
    </div>
  );
}

const LEGEND: { status: GraphNodeStatus; label: string }[] = [
  { status: "pass", label: "passed" },
  { status: "fail", label: "failed" },
  { status: "run", label: "running" },
  { status: "idle", label: "not evaluated" },
];

function GraphLegend() {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
      {LEGEND.map((entry) => (
        <li key={entry.status} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${DOT_CLASS[entry.status]}`}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

const DOT_CLASS: Record<GraphNodeStatus, string> = {
  idle: "bg-[var(--text-muted)]",
  run: "bg-[var(--accent-lime)]",
  pass: "bg-[var(--status-pass)]",
  fail: "bg-[var(--status-fail)]",
  skip: "bg-[var(--border-strong)]",
};
