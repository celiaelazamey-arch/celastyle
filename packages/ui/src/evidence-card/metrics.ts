import type { EvidenceCheck } from "./types";

/* =============================================================================
   The EngineeringEvidence contract
   -----------------------------------------------------------------------------
   A typed description of the five gates an evidence-first OS evaluates. This
   is the structured form: the compiler enforces that a run reports its test
   totals, its type-safety result, its build result, its security scan, and its
   backwards-compatibility claim.

   `EvidenceCard` still renders the looser `EvidenceCheck[]` array, because a
   real pipeline produces checks that do not fit any fixed contract. This module
   is the adapter between the two: a caller that *does* have the full contract
   can hand it over and get a check list back.
   ========================================================================== */

export type GateResult = "PASS" | "FAIL" | "WARN";

export type EvidenceMetrics = {
  unitTests: { total: number; passed: number; failed: number };
  typeCheck: GateResult;
  buildStatus: GateResult;
  securityScan: {
    status: GateResult;
    vulnerabilitiesFound: number;
    secretsExposed: boolean;
  };
  /** False means the change breaks a published contract. */
  apiBackwardsCompatible: boolean;
};

const GATE_OUTCOME = {
  PASS: "pass",
  FAIL: "fail",
  WARN: "run",
} as const satisfies Record<GateResult, EvidenceCheck["outcome"]>;

/**
 * Convert the typed contract into the check list the card renders.
 *
 * The gate order is fixed (intent, scope, tests, type, build, security, compat)
 * because the card's mini chart reads as a pipeline — a re-ordered list would
 * make the bar chart mean something different from one run to the next.
 *
 * `scope` is not part of the contract: it is supplied by the run, since what is
 * in scope is a property of the run rather than of its measurements.
 */
export function toEvidenceChecks(
  metrics: EvidenceMetrics,
  scope?: string,
): EvidenceCheck[] {
  const { unitTests, securityScan } = metrics;

  return [
    {
      id: "scope",
      label: "scope",
      outcome: "pass",
      value: scope,
    },
    {
      id: "tests",
      label: "tests",
      outcome:
        unitTests.failed === 0 ? "pass" : "fail",
      value: `${unitTests.passed}/${unitTests.total}`,
      detail: unitTests.failed > 0 ? `${unitTests.failed} failing` : undefined,
    },
    {
      id: "type",
      label: "type",
      outcome: GATE_OUTCOME[metrics.typeCheck],
      detail: metrics.typeCheck === "WARN" ? "any errors" : undefined,
    },
    {
      id: "build",
      label: "build",
      outcome: GATE_OUTCOME[metrics.buildStatus],
    },
    {
      id: "security",
      label: "security",
      outcome: GATE_OUTCOME[securityScan.status],
      value: `${securityScan.vulnerabilitiesFound} vuln`,
      detail: securityScan.secretsExposed ? "secrets exposed" : undefined,
    },
    {
      id: "compat",
      label: "compat",
      outcome: metrics.apiBackwardsCompatible ? "pass" : "fail",
      detail: metrics.apiBackwardsCompatible ? undefined : "breaking change",
    },
  ];
}

/**
 * Derive the run's verdict tone from its metrics.
 *
 * Kept as a function rather than a stored field so the verdict can never drift
 * out of sync with the numbers it claims to summarise — a rejected run whose
 * badge says "verified" is worse than no badge at all.
 */
export function deriveTone(
  metrics: EvidenceMetrics,
): "success" | "danger" | "warning" {
  if (metrics.securityScan.secretsExposed) return "danger";
  if (metrics.unitTests.failed > 0) return "danger";
  if (metrics.typeCheck === "FAIL" || metrics.buildStatus === "FAIL") {
    return "danger";
  }
  if (!metrics.apiBackwardsCompatible) return "warning";
  if (
    metrics.typeCheck === "WARN" ||
    metrics.buildStatus === "WARN" ||
    metrics.securityScan.status === "WARN"
  ) {
    return "warning";
  }
  return "success";
}
