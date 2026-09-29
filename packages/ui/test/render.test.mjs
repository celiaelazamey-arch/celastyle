/**
 * Render tests for @celastyle/ui.
 *
 * These render each component to static markup and assert on the output
 * rather than on implementation details. That matters for this package
 * specifically: the things most likely to regress silently here are the
 * accessibility semantics (ARIA roles, roving tabindex, focus handling) and
 * the data rendering (an evidence check silently dropping its `data-outcome`),
 * and none of that is caught by a type check.
 *
 * Run: npm run test -w @celastyle/ui
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import {
  CommandPalette,
  CommandRail,
  CompactCard,
  ConstraintTag,
  DashboardIcon,
  EvidenceCard,
  EvidenceGraph,
  layoutGraph,
  PolicyPanel,
  StatusBadge,
  deriveTone,
  toEvidenceChecks,
} from "../.test-build/index.js";

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
}

function group(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const count = (html, needle) => html.split(needle).length - 1;

/* --- StatusBadge --------------------------------------------------------- */
group("StatusBadge");
{
  const html = renderToStaticMarkup(h(StatusBadge, { status: "VERIFIED" }));
  check('resolves to data-status-badge="VERIFIED"', html.includes('data-status-badge="VERIFIED"'));
  check("renders its default label", html.includes("VERIFIED"));
  check(
    "emits no literal colour (tokens only)",
    !/#[0-9a-f]{3,8}\b/i.test(html),
    "a hex leaked into the component",
  );
  check(
    "is not a live region",
    !html.includes('role="status"'),
    "role=status is a live region and would re-announce every badge",
  );
}
{
  const html = renderToStaticMarkup(
    h(StatusBadge, { status: "VIOLATION", label: "REJECTED" }),
  );
  check("custom label overrides the default", html.includes("REJECTED") && !html.includes("POLICY_VIOLATION"));
  check("resolves the violation state", html.includes('data-status-badge="VIOLATION"'));
}

/* --- ConstraintTag ------------------------------------------------------- */
group("ConstraintTag");
{
  const html = renderToStaticMarkup(
    h(ConstraintTag, { kind: "security", state: "violated", value: "1" }, "no secrets"),
  );
  check('resolves to data-constraint="violated"', html.includes('data-constraint="violated"'));
  check("renders the kind label", html.includes("security"));
  check("renders the rule text", html.includes("no secrets"));
  check("renders the value", html.includes(">1<"));
  check("renders the state word", html.includes("FAIL"));
}
{
  const html = renderToStaticMarkup(
    h(ConstraintTag, { state: "pending" }, "awaiting evaluation"),
  );
  check(
    "keeps a distinct pending state",
    html.includes('data-constraint="pending"') && html.includes("EVAL"),
    "pending must not collapse into satisfied",
  );
}

/* --- EvidenceCard -------------------------------------------------------- */
group("EvidenceCard");
{
  const run = {
    id: "run-1",
    intent: "widen git refspec",
    scope: "packages/tokens",
    verdict: "REJECTED",
    tone: "danger",
    duration: "4m",
    checks: [
      { id: "scope", label: "scope", outcome: "pass" },
      { id: "tests", label: "tests", outcome: "pass", value: "24/24" },
      { id: "security", label: "security", outcome: "fail", detail: "secrets" },
      { id: "build", label: "build", outcome: "run" },
      { id: "compat", label: "compat", outcome: "skip" },
    ],
    constraints: [
      { rule: "no secrets", kind: "security", state: "violated" },
    ],
  };
  const html = renderToStaticMarkup(h(EvidenceCard, { run }));

  check("marks the card when a gate failed", html.includes("data-anyfail"));
  check("renders one row per gate", count(html, 'data-outcome=') === 5, `got ${count(html, 'data-outcome=')}`);
  check(
    "preserves all four outcomes",
    ["pass", "fail", "run", "skip"].every((o) => html.includes(`data-outcome="${o}"`)),
    "an outcome lost its data-outcome",
  );
  check("renders the mini chart as an SVG", html.includes("cs-") === false && html.includes("<svg"));
  check("exposes the chart to AT", html.includes('role="img"') && html.includes("aria-label="));
  check("labels the gate list", html.includes("Evidence gates"));
  check("renders its own ConstraintTag", html.includes("data-constraint=") && html.includes("no secrets"));
  check("maps the verdict to a badge", html.includes("REJECTED"));
}

/* --- Evidence metrics contract ------------------------------------------- */
group("EvidenceMetrics contract");
{
  const passing = {
    unitTests: { total: 24, passed: 24, failed: 0 },
    typeCheck: "PASS",
    buildStatus: "PASS",
    securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: false },
    apiBackwardsCompatible: true,
  };
  const checks = toEvidenceChecks(passing, "2 files");
  check("adapter produces gate rows", checks.length === 6, `got ${checks.length}`);
  check("clean run derives a verified tone", deriveTone(passing) === "success");

  const failing = { ...passing, unitTests: { total: 10, passed: 8, failed: 2 } };
  check("failing tests derive a rejected tone", deriveTone(failing) === "danger");
  check(
    "a failing contract never reports every gate as passing",
    toEvidenceChecks(failing, "2 files").some((c) => c.outcome === "fail"),
  );

  const breaking = { ...passing, apiBackwardsCompatible: false };
  check("a breaking change is a warning, not a pass", deriveTone(breaking) === "warning");

  const exposed = {
    ...passing,
    securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: true },
  };
  check("exposed secrets dominate the verdict", deriveTone(exposed) === "danger");
}

/* --- PolicyPanel --------------------------------------------------------- */
group("PolicyPanel");
{
  const rules = [
    { id: "r1", name: "scope_budget", description: "At most 2 files.", passed: true, requiredForRelease: true },
    { id: "r2", name: "sanitize", description: "Text is escaped.", passed: false, requiredForRelease: false },
  ];
  const closed = renderToStaticMarkup(
    h(PolicyPanel, { isOpen: false, onClose: () => {}, taskTitle: "t", overallStatus: "VERIFIED", rules }),
  );
  check("renders nothing while closed", closed === "", "a closed panel must not be in the DOM");

  const open = renderToStaticMarkup(
    h(PolicyPanel, { isOpen: true, onClose: () => {}, taskTitle: "run 1", overallStatus: "VERIFIED", rules }),
  );
  check("guarded against SSR (portal-safe)", open === "", "must defer to mounted before touching document.body");
  check("is a function component", typeof PolicyPanel === "function");
}

/* --- CommandPalette ------------------------------------------------------ */
group("CommandPalette");
{
  const closed = renderToStaticMarkup(
    h(CommandPalette, { open: false, onOpenChange: () => {}, commands: [] }),
  );
  check("renders nothing while closed", closed === "");
  check("is a function component", typeof CommandPalette === "function");
}

/* --- Evidence graph layout (pure function) -------------------------------- */
group("layoutGraph");
{
  const nodes = [
    { id: "intent", label: "Intent", status: "pass", kind: "intent", layer: 0 },
    { id: "gate-a", label: "A", status: "pass", kind: "gate", layer: 1 },
    { id: "gate-b", label: "B", status: "fail", kind: "gate", layer: 1 },
    { id: "deploy", label: "Deploy", status: "idle", kind: "deploy", layer: 2 },
  ];
  const edges = [
    { from: "intent", to: "gate-a" },
    { from: "intent", to: "gate-b" },
    { from: "gate-a", to: "deploy" },
  ];

  const layout = layoutGraph(nodes, edges);
  check("positions every node", layout.nodes.length === 4);
  check("places nodes into columns", layout.columns === 3);
  check("emits a path for every valid edge", layout.edges.length === 3);
  check("each edge path is a curve", layout.edges.every((e) => e.path.startsWith("M ")));
  check(
    "column x strictly increases",
    layout.nodes
      .filter((n) => n.kind === "gate" || n.id === "intent")
      .every((n) => typeof n.x === "number"),
  );
  check("nodes in the same column share an x", new Set(layout.nodes.filter((n)=>n.kind==="gate").map((n)=>n.x)).size === 1);

  // A dangling edge (a node that was filtered out) must be dropped, not drawn
  // to a broken endpoint.
  const dangling = layoutGraph(nodes, [...edges, { from: "ghost", to: "intent" }]);
  check("drops edges to unknown nodes", dangling.edges.length === 3, `got ${dangling.edges.length}`);

  const empty = layoutGraph([], []);
  check("handles an empty graph", empty.columns === 0 && empty.nodes.length === 0);
}

/* --- EvidenceGraph render ------------------------------------------------- */
group("EvidenceGraph");
{
  const html = renderToStaticMarkup(
    h(EvidenceGraph, {
      nodes: [
        { id: "intent", label: "Run", status: "pass", kind: "intent", layer: 0 },
        { id: "g", label: "tests", status: "fail", kind: "gate", layer: 1 },
      ],
      edges: [{ from: "intent", to: "g" }],
      label: "Test graph",
    }),
  );
  check("renders a node per entry", count(html, "data-node=") === 2, `got ${count(html, "data-node=")}`);
  check("preserves node status", html.includes('data-status="fail"') && html.includes('data-status="pass"'));
  check("preserves node kind", html.includes('data-kind="gate"'));
  check("renders edges as an SVG", html.includes("<svg") && html.includes("<path"));
  check("renders a legend", html.includes("not evaluated") && html.includes("running"));
  check("announces the graphic", html.includes("Test graph"));

  const empty = renderToStaticMarkup(h(EvidenceGraph, { nodes: [], edges: [], label: "Empty" }));
  check("renders an empty state", empty.includes("no evidence to graph"));
}

/* --- CommandRail --------------------------------------------------------- */
group("CommandRail");
{
  const items = [
    { id: "a", label: "Alpha", icon: h(DashboardIcon, {}) },
    { id: "b", label: "Beta", badge: 3, shortcut: "⌘B" },
    { id: "c", label: "Gamma", disabled: true },
  ];
  const html = renderToStaticMarkup(h(CommandRail, { items, value: "a" }));
  check("is a tablist", html.includes('role="tablist"'));
  check("is vertically oriented", html.includes('aria-orientation="vertical"'));
  check("marks the active tab", html.includes('aria-selected="true"'));
  check("honours disabled items", html.includes("disabled"));
  check(
    "roving tabindex — exactly one tab stop",
    count(html, 'tabindex="0"') === 1,
    `got ${count(html, 'tabindex="0"')}`,
  );
  check("renders the badge", html.includes(">3<"));
  check("keeps the shortcut in the label", html.includes("⌘B"));
}

/* --- CompactCard --------------------------------------------------------- */
group("CompactCard");
{
  const html = renderToStaticMarkup(
    h(CompactCard, {
      title: "Deploy ok",
      status: "success",
      meta: "14:02",
      onClick: () => {},
      data: [{ label: "src", value: "pipe" }],
    }),
  );
  check("uses a real button as the trigger", html.includes("cs-card__action"));
  check("marks itself interactive", html.includes("data-interactive"));
  check(
    "does not fake a button role on the article",
    !html.includes('role="button"'),
    "interactive elements were nested inside a role=button",
  );
}

/* --- Summary ------------------------------------------------------------- */
console.log(
  `\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`,
);
process.exit(fail === 0 ? 0 : 1);
