import type {
  EvidenceRun,
  PolicyBranch,
  StatusBadgeTone,
} from "@celastyle/ui";

/* -----------------------------------------------------------------------------
 * Evidence fixtures.
 *
 * Modelled on how an evidence-first OS actually records a change: an intent,
 * a declared scope, five ordered gates, a verdict, and the constraints that
 * were checked along the way. The numbers are the kind a real run would emit.
 * -------------------------------------------------------------------------- */

export type EvidenceSummary = {
  verified: number;
  rejected: number;
  pending: number;
};

export const EVIDENCE_SUMMARY: EvidenceSummary = {
  verified: 3,
  rejected: 1,
  pending: 1,
};

export const EVIDENCE_RUNS: EvidenceRun[] = [
  {
    id: "run-4417",
    intent: "widen git refspec to include all branches",
    scope: "packages/tokens · config only",
    verdict: "verified",
    tone: "success",
    duration: "4m 12s",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      { id: "scope", label: "scope", outcome: "pass", value: "2 files" },
      { id: "tests", label: "tests", outcome: "pass", value: "24 tests" },
      { id: "build", label: "build", outcome: "pass", value: "1.8s" },
      { id: "security", label: "security", outcome: "pass", value: "clean" },
    ],
    constraints: [
      { rule: "no secrets in diff", kind: "security", state: "satisfied" },
      { rule: "build under 5s", kind: "perf", state: "satisfied", value: "1.8s" },
    ],
  },
  {
    id: "run-4412",
    intent: "postcss advisory override",
    scope: "root · dependency only",
    verdict: "verified",
    tone: "success",
    duration: "2m 48s",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      { id: "scope", label: "scope", outcome: "pass", value: "1 file" },
      { id: "tests", label: "tests", outcome: "pass", value: "build ok" },
      { id: "build", label: "build", outcome: "pass", value: "1.2s" },
      {
        id: "security",
        label: "security",
        outcome: "pass",
        value: "0 vulns",
        detail: "clears 2 advisories",
      },
    ],
    constraints: [
      { rule: "no breaking upgrade", kind: "compat", state: "satisfied" },
      { rule: "0 known vulns", kind: "security", state: "satisfied", value: "0" },
    ],
  },
  {
    id: "run-4408",
    intent: "extract audit trail to policy panel",
    scope: "packages/ui · policy-panel",
    verdict: "rejected",
    tone: "danger",
    duration: "11m 03s",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      {
        id: "scope",
        label: "scope",
        outcome: "fail",
        value: "+3 files",
        detail: "exceeded scope budget",
      },
      { id: "tests", label: "tests", outcome: "skip", detail: "blocked by scope" },
      { id: "build", label: "build", outcome: "skip", detail: "blocked by scope" },
      {
        id: "security",
        label: "security",
        outcome: "fail",
        detail: "raw HTML injection risk",
      },
    ],
    constraints: [
      { rule: "≤ 2 files per run", kind: "scope", state: "violated", value: "5" },
      { rule: "sanitize policy text", kind: "security", state: "violated" },
    ],
  },
  {
    id: "run-4403",
    intent: "add ⌘K command palette",
    scope: "packages/ui · command-palette",
    verdict: "verified",
    tone: "success",
    duration: "8m 27s",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      { id: "scope", label: "scope", outcome: "pass", value: "3 files" },
      { id: "tests", label: "tests", outcome: "pass", value: "12 tests" },
      { id: "build", label: "build", outcome: "pass", value: "2.1s" },
      { id: "security", label: "security", outcome: "pass", value: "clean" },
    ],
    constraints: [
      { rule: "focus returns to trigger", kind: "compat", state: "satisfied" },
      { rule: "aria-modal dialog", kind: "policy", state: "satisfied" },
    ],
  },
  {
    id: "run-4399",
    intent: "propose Tailwind theme bridge",
    scope: "apps/command-center",
    verdict: "needs review",
    tone: "warning",
    duration: "running",
    checks: [
      { id: "intent", label: "intent", outcome: "pass", value: "aligned" },
      { id: "scope", label: "scope", outcome: "pass", value: "1 file" },
      { id: "tests", label: "tests", outcome: "pass", value: "8 tests" },
      { id: "build", label: "build", outcome: "run", detail: "compiling…" },
      { id: "security", label: "security", outcome: "run", detail: "queued" },
    ],
    constraints: [
      { rule: "no circular theme refs", kind: "policy", state: "satisfied" },
      { rule: "both themes render", kind: "compat", state: "pending" },
    ],
  },
];

/* -----------------------------------------------------------------------------
 * Policy / decision graph.
 * -------------------------------------------------------------------------- */

export const POLICY_BRANCHES: PolicyBranch[] = [
  {
    id: "branch-accept",
    label: "accept",
    tone: "success",
    rationale: "All five gates passed and every declared constraint held.",
    nodes: [
      {
        id: "n1",
        label: "refspec fix verified",
        detail: "24/24 tests · build 1.8s",
        tone: "success",
        time: "4m",
      },
      {
        id: "n2",
        label: "dependency override cleared advisories",
        detail: "postcss 8.4.31 → 8.5.28",
        tone: "success",
        time: "11m",
        children: [
          {
            id: "n2a",
            label: "no breaking upgrade",
            detail: "next pinned to 15.5.26",
            tone: "success",
            time: "11m",
          },
        ],
      },
    ],
  },
  {
    id: "branch-reject",
    label: "reject",
    tone: "danger",
    rationale: "Scope and security gates failed; run did not reach tests.",
    nodes: [
      {
        id: "n3",
        label: "policy panel extraction rejected",
        detail: "3 gates failed",
        tone: "danger",
        time: "52m",
        children: [
          {
            id: "n3a",
            label: "scope budget exceeded",
            detail: "5 files vs 2 allowed",
            tone: "danger",
            time: "52m",
          },
          {
            id: "n3b",
            label: "raw HTML injection risk",
            detail: "unescaped audit text",
            tone: "danger",
            time: "52m",
          },
        ],
      },
    ],
  },
  {
    id: "branch-escalate",
    label: "escalate",
    tone: "warning",
    rationale: "One run still in flight; needs human sign-off before merge.",
    nodes: [
      {
        id: "n4",
        label: "theme bridge awaiting review",
        detail: "build running",
        tone: "warning",
        time: "1h",
        children: [
          {
            id: "n4a",
            label: "light theme unverified",
            detail: "compatibility pending",
            tone: "neutral",
            time: "1h",
          },
        ],
      },
    ],
  },
];

/* Verdict → tone, used for the summary chips above the run list. */
export const VERDICT_TONE: Record<string, StatusBadgeTone> = {
  verified: "success",
  rejected: "danger",
  "needs review": "warning",
};
