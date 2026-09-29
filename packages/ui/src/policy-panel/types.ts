import type { ReactNode } from "react";

/** A policy rule evaluated for a run. */
export type PolicyRule = {
  id: string;
  name: string;
  /** The evidence behind the rule's outcome. */
  description: string;
  passed: boolean;
  /** Release-blocking rules are marked so the operator can see the hard gates. */
  requiredForRelease: boolean;
};

export type PolicyPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  /** What the panel is adjudicating, shown under the heading. */
  taskTitle: string;
  /** The run's verdict. */
  overallStatus: "VERIFIED" | "REJECTED" | "PENDING" | "VIOLATION";
  rules: readonly PolicyRule[];
  /** Label for the gate-status banner. */
  statusLabel?: string;
  footer?: ReactNode;
};
