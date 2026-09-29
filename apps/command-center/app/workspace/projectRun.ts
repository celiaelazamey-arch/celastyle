import type { GraphEdge, GraphNode } from "@celastyle/ui";
import type { LiveRun } from "./useEvidenceStream";

/* =============================================================================
   Telemetry → graph projection
   -----------------------------------------------------------------------------
   Pure, and shared between the panel and its test. The projection is where a
   bug would be both likely and invisible in the UI: a gate that never gets a
   node, a decision that renders before a verdict exists, or an edge pointing
   at a column that was never built.

   Keeping it here rather than inline in the panel is what makes it testable —
   the test drives this function, not a copy of it.
   ========================================================================== */

const GATE_LABEL: Record<string, string> = {
  scope: "scope",
  tests: "tests",
  type: "type",
  build: "build",
  security: "security",
  compat: "compat",
};

export type Projection = { nodes: GraphNode[]; edges: GraphEdge[] };

export function projectRun(run: LiveRun): Projection {
  const nodes: GraphNode[] = [
    {
      id: "intent",
      label: run.runId,
      detail: run.scope,
      status: "pass",
      kind: "intent",
      layer: 0,
    },
    {
      id: "constraint",
      label: "constraints",
      detail: "policy scope",
      status: run.gates.scope ? "pass" : "idle",
      kind: "constraint",
      layer: 1,
    },
  ];

  const edges: GraphEdge[] = [{ from: "intent", to: "constraint" }];

  for (const [gate, state] of Object.entries(run.gates)) {
    const id = `gate-${gate}`;
    nodes.push({
      id,
      label: GATE_LABEL[gate] ?? gate,
      detail: state.value ?? state.detail,
      status: state.outcome,
      kind: "gate",
      layer: 2,
    });
    edges.push({ from: "constraint", to: id });
  }

  const hasFailure = Object.values(run.gates).some((g) => g.outcome === "fail");
  const decided = Boolean(run.verdict);

  nodes.push({
    id: "decision",
    label: "decision",
    detail: run.verdict,
    status: decided
      ? run.verdict === "VERIFIED"
        ? "pass"
        : run.verdict === "REJECTED"
          ? "fail"
          : "run"
      : "run",
    kind: "decision",
    layer: 3,
  });

  for (const gate of Object.keys(run.gates)) {
    edges.push({ from: `gate-${gate}`, to: "decision" });
  }

  nodes.push({
    id: "deploy",
    label: "deploy",
    detail: run.deploy ? `production · ${run.deploy.outcome}` : "pending",
    status: run.deploy ? "pass" : "idle",
    kind: "deploy",
    layer: 4,
  });
  edges.push({ from: "decision", to: "deploy" });

  return {
    nodes,
    // One violated flag on every edge is coarse but honest: when any gate has
    // failed the whole path to the decision is suspect, and the decision node
    // is where that resolves. The per-node status carries the detail.
    edges: edges.map((e) => ({ ...e, violated: hasFailure })),
  };
}
