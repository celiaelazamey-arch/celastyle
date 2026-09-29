import {
  deriveTone,
  toEvidenceChecks,
  type EvidenceMetrics,
  type EvidenceRun,
  type PolicyRule,
} from "@celastyle/ui";

/* -----------------------------------------------------------------------------
 * Evidence fixtures.
 *
 * These use the typed EngineeringEvidence contract and the adapter, so the
 * shape a real pipeline would emit is exercised rather than a hand-written
 * check list. The verdict tone is *derived* from the metrics — see deriveTone —
 * so a fixture cannot claim "verified" while its numbers say otherwise.
 * -------------------------------------------------------------------------- */

/* Declared before RUNS: the module initialises RUNS by calling buildRun, which
   reads this map, so it has to be assigned first or the access hits the TDZ. */
const VERDICT_LABEL: Record<string, string> = {
  success: "VERIFIED",
  danger: "REJECTED",
  warning: "IN_REVIEW",
};

export const RUNS: EvidenceRun[] = [
  buildRun({
    id: "4417",
    intent: "widen git refspec to include all branches",
    scope: "2 files · config only",
    timestamp: "14:02:11",
    duration: "4m 12s",
    metrics: {
      unitTests: { total: 24, passed: 24, failed: 0 },
      typeCheck: "PASS",
      buildStatus: "PASS",
      securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: false },
      apiBackwardsCompatible: true,
    },
    constraints: [
      { rule: "no secrets in diff", kind: "security", state: "satisfied" },
      { rule: "build under 5s", kind: "perf", state: "satisfied", value: "1.8s" },
      { rule: "≤ 2 files per run", kind: "scope", state: "satisfied", value: "2" },
    ],
  }),
  buildRun({
    id: "4412",
    intent: "clear postcss advisory without a breaking upgrade",
    scope: "1 file · dependency only",
    timestamp: "13:58:40",
    duration: "2m 48s",
    metrics: {
      unitTests: { total: 24, passed: 24, failed: 0 },
      typeCheck: "PASS",
      buildStatus: "PASS",
      securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: false },
      apiBackwardsCompatible: true,
    },
    constraints: [
      { rule: "no breaking upgrade", kind: "compat", state: "satisfied" },
      { rule: "0 known vulns", kind: "security", state: "satisfied", value: "0" },
    ],
  }),
  buildRun({
    id: "4408",
    intent: "extract the audit trail into a policy panel",
    scope: "packages/ui · policy-panel",
    timestamp: "13:12:09",
    duration: "11m 03s",
    metrics: {
      unitTests: { total: 12, passed: 12, failed: 0 },
      typeCheck: "PASS",
      buildStatus: "PASS",
      securityScan: { status: "WARN", vulnerabilitiesFound: 1, secretsExposed: false },
      apiBackwardsCompatible: false,
    },
    constraints: [
      { rule: "≤ 2 files per run", kind: "scope", state: "violated", value: "5" },
      { rule: "sanitize policy text", kind: "security", state: "violated" },
      { rule: "preserve public API", kind: "compat", state: "violated" },
    ],
  }),
  buildRun({
    id: "4403",
    intent: "add a ⌘K command palette",
    scope: "3 files · command-palette",
    timestamp: "12:40:31",
    duration: "8m 27s",
    metrics: {
      unitTests: { total: 12, passed: 12, failed: 0 },
      typeCheck: "PASS",
      buildStatus: "PASS",
      securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: false },
      apiBackwardsCompatible: true,
    },
    constraints: [
      { rule: "focus returns to trigger", kind: "compat", state: "satisfied" },
      { rule: "aria-modal dialog", kind: "policy", state: "satisfied" },
      { rule: "one tab stop", kind: "policy", state: "satisfied" },
    ],
  }),
  buildRun({
    id: "4399",
    intent: "bridge the Tailwind theme to the token layer",
    scope: "1 file · globals.css",
    timestamp: "12:05:17",
    duration: "running",
    metrics: {
      unitTests: { total: 8, passed: 8, failed: 0 },
      typeCheck: "PASS",
      buildStatus: "WARN",
      securityScan: { status: "PASS", vulnerabilitiesFound: 0, secretsExposed: false },
      apiBackwardsCompatible: true,
    },
    constraints: [
      { rule: "no circular theme refs", kind: "policy", state: "satisfied" },
      { rule: "both themes render", kind: "compat", state: "pending" },
    ],
  }),
];

function buildRun(input: {
  id: string;
  intent: string;
  scope: string;
  timestamp: string;
  duration: string;
  metrics: EvidenceMetrics;
  constraints: NonNullable<EvidenceRun["constraints"]>;
}): EvidenceRun {
  const tone = deriveTone(input.metrics);
  return {
    id: input.id,
    intent: input.intent,
    scope: input.scope,
    timestamp: input.timestamp,
    duration: input.duration,
    verdict: VERDICT_LABEL[tone],
    tone,
    checks: toEvidenceChecks(input.metrics, input.scope),
    constraints: input.constraints,
  };
}

/* -----------------------------------------------------------------------------
 * Policy rules for the slide-over.
 * -------------------------------------------------------------------------- */

export const POLICY_RULES: Record<string, PolicyRule[]> = {
  "4417": [
    {
      id: "r1",
      name: "scope_budget",
      description: "The run touched at most 2 files.",
      passed: true,
      requiredForRelease: true,
    },
    {
      id: "r2",
      name: "no_secrets",
      description: "No credentials or tokens in the diff.",
      passed: true,
      requiredForRelease: true,
    },
    {
      id: "r3",
      name: "build_budget",
      description: "Production build completes in under 5s.",
      passed: true,
      requiredForRelease: false,
    },
  ],
  "4408": [
    {
      id: "r1",
      name: "scope_budget",
      description: "The run touched at most 2 files.",
      passed: false,
      requiredForRelease: true,
    },
    {
      id: "r2",
      name: "sanitize_policy_text",
      description: "Audit text is escaped before rendering.",
      passed: false,
      requiredForRelease: true,
    },
    {
      id: "r3",
      name: "preserve_public_api",
      description: "Exported types are unchanged across the release.",
      passed: false,
      requiredForRelease: true,
    },
    {
      id: "r4",
      name: "dependency_audit",
      description: "No unresolved advisories in the tree.",
      passed: true,
      requiredForRelease: false,
    },
  ],
};

export const EVIDENCE_SUMMARY = {
  verified: RUNS.filter((r) => r.tone === "success").length,
  rejected: RUNS.filter((r) => r.tone === "danger").length,
  inFlight: RUNS.filter((r) => r.tone === "warning").length,
};
