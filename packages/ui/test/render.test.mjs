/**
 * Render tests for @celastyle/ui.
 *
 * These render each component to static markup and assert on the output
 * rather than on implementation details. That matters for this package
 * specifically: the things most likely to regress silently here are the
 * accessibility semantics (ARIA roles, roving tabindex) and the data
 * rendering (an evidence check silently dropping its `data-outcome`), and
 * neither is caught by a type check.
 *
 * Run: npm run test -w @celastyle/ui
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import {
  CommandRail,
  CompactCard,
  ConstraintTag,
  DashboardIcon,
  EvidenceCard,
  PolicyPanel,
  StatusBadge,
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
  const html = renderToStaticMarkup(
    h(StatusBadge, { tone: "success", children: "verified" }),
  );
  check('resolves tone to data-tone="success"', html.includes('data-tone="success"'));
  check("renders its label", html.includes("verified"));
  check(
    "emits no literal colour (tokens only)",
    !/#[0-9a-f]{3,8}\b/i.test(html),
    "a hex leaked into the component",
  );
}
{
  const html = renderToStaticMarkup(
    h(StatusBadge, { tone: "danger", variant: "solid", live: true, children: "running" }),
  );
  check('supports variant="solid"', html.includes('data-variant="solid"'));
  check("renders a live indicator", html.includes("cs-badge__live"));
}

/* --- ConstraintTag ------------------------------------------------------- */
group("ConstraintTag");
{
  const html = renderToStaticMarkup(
    h(ConstraintTag, { kind: "security", state: "violated", value: "1", children: "no secrets" }),
  );
  check('resolves state to data-state="violated"', html.includes('data-state="violated"'));
  check("renders the kind label", html.includes("security"));
  check("renders the rule text", html.includes("no secrets"));
  check("renders the value", html.includes(">1<"));
}

/* --- EvidenceCard -------------------------------------------------------- */
group("EvidenceCard");
{
  const run = {
    id: "run-1",
    intent: "widen git refspec",
    scope: "packages/tokens",
    verdict: "verified",
    tone: "success",
    duration: "4m",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      { id: "scope", label: "scope", outcome: "pass" },
      { id: "tests", label: "tests", outcome: "fail", detail: "regressed" },
      { id: "build", label: "build", outcome: "run" },
      { id: "security", label: "security", outcome: "skip" },
    ],
    constraints: [{ rule: "no secrets", kind: "security", state: "satisfied" }],
  };
  const html = renderToStaticMarkup(h(EvidenceCard, { run }));

  check("marks the card when a check failed", html.includes("data-anyfail"));
  check("renders one row per check", count(html, 'class="cs-check"') === 5, `got ${count(html, 'class="cs-check"')}`);
  check(
    "preserves all four outcomes",
    ["pass", "fail", "run", "skip"].every((o) => html.includes(`data-outcome="${o}"`)),
    "an outcome lost its data-outcome",
  );
  check("renders the mini chart as an SVG", html.includes("cs-evidence__chart") && html.includes("<svg"));
  check("exposes the chart to AT", html.includes('role="img"') && html.includes("aria-label="));
  check("one bar per check", count(html, "cs-evidence__bar") === 5, `got ${count(html, "cs-evidence__bar")}`);
  check("labels the check list", html.includes('aria-label="Evidence checks"'));
  check("renders its own ConstraintTag", html.includes("cs-constraint") && html.includes("no secrets"));
}

/* --- PolicyPanel --------------------------------------------------------- */
group("PolicyPanel");
{
  const branches = [
    {
      id: "b1",
      label: "accept",
      tone: "success",
      rationale: "all gates passed",
      nodes: [
        {
          id: "n1",
          label: "refspec verified",
          detail: "24 tests",
          tone: "success",
          time: "4m",
          children: [{ id: "n1a", label: "no breaking upgrade", tone: "success" }],
        },
      ],
    },
  ];
  const html = renderToStaticMarkup(h(PolicyPanel, { branches }));
  check("renders the branch", html.includes("accept"));
  check("renders the rationale", html.includes("all gates passed"));
  check("renders nested child nodes", html.includes("no breaking upgrade"));
  check("renders the node list", html.includes("cs-node-list"));
  check("renders timestamps", html.includes("4m"));
  check('names the landmark', html.includes('aria-label="Policy"'));
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

/* --- CompactCard (regression guard) -------------------------------------- */
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
