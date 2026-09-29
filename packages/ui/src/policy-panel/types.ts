import type { ReactNode } from "react";
import type { StatusBadgeTone } from "../status-badge/types";

/** A node in the evidence decision graph. */
export type PolicyNode = {
  id: string;
  /** e.g. "scope verified", "reject: perf budget". */
  label: string;
  /** Detail line — the evidence that produced the decision. */
  detail?: string;
  tone: StatusBadgeTone;
  /** "just now", "4m ago". Rendered in mono. */
  time?: string;
  /** Nesting depth, 0-based. Rendered as a guide rail. */
  depth?: number;
  /** Branch children, rendered below this node. */
  children?: PolicyNode[];
};

/** A named branch in the decision tree, e.g. "reject" or "escalate". */
export type PolicyBranch = {
  id: string;
  label: string;
  tone: StatusBadgeTone;
  /** The reasoning that leads into this branch. */
  rationale?: string;
  nodes?: PolicyNode[];
};

export type PolicyPanelProps = {
  title?: string;
  /** Short line under the title — what this panel is showing. */
  description?: string;
  /** Decision graph entries, newest first. */
  branches: readonly PolicyBranch[];
  /** Footer content, e.g. a hash or provenance link. */
  footer?: ReactNode;
  className?: string;
};
