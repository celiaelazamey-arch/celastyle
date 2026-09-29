import type { GraphEdge, GraphNode } from "@celastyle/ui";
import type { GateState, LiveRun } from "./useEvidenceStream";

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

/**
 * Collapse the wire's lifecycle states onto the graph's vocabulary.
 *
 * The stream has more states than the graph needs: a gate is "run" before the
 * server has said anything, "running" while the command is live, and
 * "resolved" for the instant between the command exiting and its result
 * arriving. All three mean the same thing to a reader — the gate has not
 * produced an answer yet — so the graph shows them as one in-flight state
 * rather than flickering through three.
 */
function toStatus(outcome: GateState["outcome"]): GraphNode["status"] {
  if (outcome === "pass" || outcome === "fail" || outcome === "skip") return outcome;
  return "idle";
}

export function projectRun(run: LiveRun): Projection {
  const scope = run.gates.scope;

  const nodes: GraphNode[] = [
    {
      id: "intent",
      label: run.runId || "verifying",
      detail: run.scope || run.intent,
      /* The intent is not a gate and can never fail — it is the run's own
         identity, so it is only "settled" once the run has produced a verdict.
         Marking it passed up front would assert a conclusion before there is
         one. */
      status: run.verdict ? "pass" : "idle",
      kind: "intent",
      layer: 0,
    },
    {
      id: "constraint",
      label: "constraints",
      /* The scope constraint holds only when the scope gate actually passed.
         Testing an object for truthiness counted any non-empty object — which
         is every gate, running or not — so this node claimed the scope was
         constrained while the scope gate was still unresolved. */
      detail: scope?.value ?? "measuring scope",
      status: toStatus(scope?.outcome ?? "run"),
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
      detail: state.detail ?? state.value,
      status: toStatus(state.outcome),
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
    /* Deploy is a consequence of the decision, so it mirrors it. Reporting
       "pending" for a run that was explicitly REJECTED was misleading: the
       deploy did not wait, it never happened. A rejected run must read as a
       failed deploy, and a run still in flight must not claim either. */
    status: !decided
      ? "idle"
      : run.deploy
        ? "pass"
        : run.verdict === "REJECTED"
          ? "fail"
          : "idle",
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
