/**
 * Telemetry → graph projection.
 *
 * Drives the same `projectRun` the panel uses, so this is not a copy that can
 * drift. The projection is where a bug would be both likely and invisible in
 * the UI: a gate that never gets a node, a decision that renders before a
 * verdict exists, or an edge pointing at a column that was never built.
 *
 * Run: node test/telemetry.test.mjs  (after `npm run test -w @celastyle/ui`)
 */
import { layoutGraph } from "../.test-build/index.js";
import { projectRun } from "../.test-build-workspace/workspace/projectRun.js";

/** Minimal stand-in for the LiveRun the SSE hook folds events into. */
function makeRun(overrides = {}) {
  return {
    runId: "9001",
    intent: "widen the refspec",
    scope: "packages/tokens",
    gates: {
      scope: { outcome: "pass" },
      tests: { outcome: "pass", value: "25/25" },
      type: { outcome: "pass" },
      build: { outcome: "run" },
      security: { outcome: "run" },
      compat: { outcome: "run" },
    },
    verdict: undefined,
    deploy: undefined,
    at: 0,
    ...overrides,
  };
}

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
};

console.log("\n\x1b[1mTelemetry → graph projection\x1b[0m");

{
  const { nodes, edges } = projectRun(makeRun());
  const gates = nodes.filter((n) => n.kind === "gate");
  check("projects every gate into a node", gates.length === 6, `got ${gates.length}`);
  check("lays out across the five layers", new Set(nodes.map((n) => n.layer)).size === 5);
  check(
    "every edge resolves to a real node",
    layoutGraph(nodes, edges).edges.length === edges.length,
  );
  check("carries a gate's measurement into the node", gates.some((g) => g.detail === "25/25"));
}

{
  const { nodes } = projectRun(makeRun({ verdict: "VERIFIED" }));
  const decision = nodes.find((n) => n.id === "decision");
  check("decision reads passed after VERIFIED", decision.status === "pass");
  check("decision shows the verdict", decision.detail === "VERIFIED");
}

{
  const { nodes } = projectRun(makeRun({ verdict: "REJECTED" }));
  check("decision reads failed after REJECTED", nodes.find((n) => n.id === "decision").status === "fail");
}

{
  const { nodes, edges } = projectRun(
    makeRun({ gates: { tests: { outcome: "fail" } } }),
  );
  check("a failed gate marks the path violated", edges.some((e) => e.violated));
  check("decision stays running until a verdict exists", nodes.find((n) => n.id === "decision").status === "run");
  check("the failing gate is not marked passed", nodes.find((n) => n.id === "gate-tests").status === "fail");
}

{
  const { nodes } = projectRun(
    makeRun({
      verdict: "VERIFIED",
      deploy: { environment: "production", outcome: "pass" },
    }),
  );
  const deploy = nodes.find((n) => n.id === "deploy");
  check("deploy reflects the environment", deploy.detail === "production · pass");
  check("deploy reads passed once a verified run lands one", deploy.status === "pass");
}

{
  // The defect this guards: a deploy event with no verdict behind it must not
  // paint the run green. Deployment is a consequence of a decision, so it
  // cannot exist before the decision does.
  const { nodes } = projectRun(
    makeRun({ deploy: { environment: "production", outcome: "pass" } }),
  );
  check(
    "a deploy with no verdict does not read as passed",
    nodes.find((n) => n.id === "deploy").status !== "pass",
  );
}

{
  // A rejected run did not "wait" to deploy — it never deployed. Reporting
  // "pending" would leave the panel looking like work still to come.
  const { nodes } = projectRun(makeRun({ verdict: "REJECTED" }));
  check("a rejected run shows a failed deploy", nodes.find((n) => n.id === "deploy").status === "fail");
}

{
  const { nodes } = projectRun(makeRun());
  check("deploy is idle before one lands", nodes.find((n) => n.id === "deploy").status === "idle");
}

{
  // A run that has only just started still has all six gates in a running
  // state; the graph must render the whole skeleton immediately rather than
  // growing a column at a time.
  const run = makeRun({
    gates: {
      scope: { outcome: "run" },
      tests: { outcome: "run" },
      type: { outcome: "run" },
      build: { outcome: "run" },
      security: { outcome: "run" },
      compat: { outcome: "run" },
    },
  });
  const { nodes } = projectRun(run);
  const layout = layoutGraph(nodes, projectRun(run).edges);
  // intent + constraint + 6 gates + decision + deploy = 10
  check("a fresh run still lays out completely", layout.nodes.length === 10, `got ${layout.nodes.length}`);
  /* The wire has three in-flight states — "run" before the server has spoken,
     "running" while a command is live, "resolved" in the instant before its
     result lands. The graph collapses all three to "idle" so a reader sees one
     consistent "not answered yet" state instead of three flickering ones. */
  check(
    "every unresolved gate reads as not-answered",
    nodes.filter((n) => n.kind === "gate").every((n) => n.status === "idle"),
  );
}

{
  // The constraint node used to be `run.gates.scope ? "pass" : "idle"`, which
  // is truthiness on an object: every gate object is truthy, running or not,
  // so the scope read as constrained before it had been measured.
  const { nodes } = projectRun(
    makeRun({ gates: { ...makeRun().gates, scope: { outcome: "run" } } }),
  );
  check(
    "an unresolved scope does not claim the constraint holds",
    nodes.find((n) => n.id === "constraint").status !== "pass",
  );
}

{
  const { nodes } = projectRun(
    makeRun({ gates: { ...makeRun().gates, scope: { outcome: "pass", value: "5 files" } } }),
  );
  const constraint = nodes.find((n) => n.id === "constraint");
  check("a measured scope holds the constraint", constraint.status === "pass");
  check("the constraint shows the measured scope", constraint.detail === "5 files", `got ${constraint.detail}`);
}

{
  // A review gate is real, completed, and unconfirmed. The graph has no
  // review glyph, so it must fall back to the honest existing state — idle,
  // "not settled" — rather than being rounded up to a pass.
  const run = makeRun({
    gates: { ...makeRun().gates, compat: { outcome: "review" } },
  });
  const { nodes } = projectRun(run);
  const compat = nodes.find((n) => n.id === "gate-compat");
  check("a review gate is not drawn as passed", compat.status !== "pass", `got ${compat.status}`);
  check("a review gate reads as not settled", compat.status === "idle", `got ${compat.status}`);
}

{
  // ...and a review gate must not mark the path as violated: nothing failed.
  const run = makeRun({
    gates: { ...makeRun().gates, compat: { outcome: "review" } },
  });
  const { edges } = projectRun(run);
  check("a review gate does not violate the path", edges.every((e) => e.violated === false));
}

{
  /* A1 focuses the graph on whichever gates the rail flags. That only works if
     a flagged gate is addressable as a real node, so the identifier the UI
     builds ("gate-" + id) has to actually match a node in the projection.
     A mismatch would fail silently: the button would set a selection that
     matches nothing and the reviewer would see no focus at all. */
  const run = makeRun({
    gates: { ...makeRun().gates, security: { outcome: "fail", value: "3 vuln" } },
  });
  const { nodes } = projectRun(run);
  const flagged = "security";
  const attentionId = `gate-${flagged}`;
  const node = nodes.find((n) => n.id === attentionId);
  check("a flagged gate resolves to a real graph node", node !== undefined, attentionId);
  check("the flagged node carries the failure", node.status === "fail", `got ${node?.status}`);
}

{
  // And the inverse — the happy run must produce nothing to focus, or the
  // graph would point at an arbitrary node on every clean run.
  const run = makeRun({
    gates: Object.fromEntries(
      Object.entries(makeRun().gates).map(([id, g]) => [id, { ...g, outcome: "pass" }]),
    ),
  });
  const flagged = Object.entries(run.gates).filter(([, g]) => g.outcome === "fail" || g.outcome === "review");
  check("a fully passing run flags no gate to focus", flagged.length === 0, `got ${flagged.length}`);
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
