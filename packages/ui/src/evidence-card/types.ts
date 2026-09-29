import type { ReactNode } from "react";
import type { StatusBadgeTone } from "../status-badge/types";
import type {
  ConstraintKind,
  ConstraintState,
} from "../constraint-tag/ConstraintTag";

/** Outcome of a single evidence check. */
export type CheckOutcome = "pass" | "fail" | "skip" | "run";

export type EvidenceCheck = {
  /** Short check name, e.g. "intent", "tests", "security". */
  id: string;
  label: string;
  outcome: CheckOutcome;
  /** Optional measurement, e.g. "128 tests" or "1.2s". */
  value?: string;
  /** Human-readable reason for a fail/skip. */
  detail?: string;
};

/** A declared constraint evaluated during a run. Plain data, not an element —
 *  the card owns rendering so a fixture stays serialisable and theme-aware. */
export type EvidenceConstraint = {
  /** Stable key. */
  id?: string;
  /** The rule itself, e.g. "no secrets in diff". */
  rule: string;
  kind: ConstraintKind;
  state: ConstraintState;
  /** Short measurement, e.g. "1.8s". */
  value?: string;
};

/** Per-run evidence record. */
export type EvidenceRun = {
  id: string;
  /** Headline, e.g. "fix refspec sync" or a commit subject. */
  intent: string;
  /** Free-form scope description. */
  scope?: string;
  /** Verdict, e.g. "verified", "rejected", "needs review". */
  verdict: string;
  tone: StatusBadgeTone;
  /** Overall timing, shown in the card footer. */
  duration?: string;
  /** The five checks, in the order they ran. */
  checks: readonly EvidenceCheck[];
  /** Declared constraints evaluated during this run. */
  constraints?: readonly EvidenceConstraint[];
  children?: ReactNode;
};

export type EvidenceCardProps = {
  run: EvidenceRun;
  /** Show a two-column mini bar chart across the check row. */
  chart?: boolean;
  className?: string;
};
