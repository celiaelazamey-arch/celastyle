import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import "./constraint-tag.css";

/** What kind of rule a constraint represents. Drives the glyph and the
 *  default label; it is not a severity. */
export type ConstraintKind =
  | "scope"
  | "security"
  | "perf"
  | "compat"
  | "budget"
  | "policy";

/** Whether the constraint currently holds. */
export type ConstraintState = "satisfied" | "violated" | "pending";

export type ConstraintTagProps = {
  /** The rule itself, e.g. "no secrets in build output". */
  children: ReactNode;
  kind?: ConstraintKind;
  state?: ConstraintState;
  /** Short value shown after the rule, e.g. "12 files" or "1.2s". */
  value?: ReactNode;
  /** Overrides the default kind label. */
  label?: string;
  className?: string;
};

const KIND_LABEL: Record<ConstraintKind, string> = {
  scope: "scope",
  security: "security",
  perf: "perf",
  compat: "compat",
  budget: "budget",
  policy: "policy",
};

/**
 * ConstraintTag — a declared rule and whether it currently holds.
 *
 * Deliberately distinct from StatusBadge: a status is an *outcome* ("verified"),
 * a constraint is a *rule* ("no secrets in build output"). Keeping the two
 * visually and structurally apart is what stops an evidence view from reading as
 * a wall of undifferentiated chips.
 */
export function ConstraintTag({
  children,
  kind = "policy",
  state = "pending",
  value,
  label,
  className,
}: ConstraintTagProps) {
  return (
    <span
      className={cn("cs-constraint", className)}
      data-state={state}
      data-kind={kind}
    >
      {/* The leading slash is decorative — the kind name carries the meaning and
          is always present, so nothing is communicated by the glyph alone. */}
      <span className="cs-constraint__mark" aria-hidden="true" />
      <span className="cs-constraint__kind">
        {label ?? KIND_LABEL[kind]}
      </span>
      <span className="cs-constraint__rule">{children}</span>
      {value ? (
        <span className="cs-constraint__value">{value}</span>
      ) : null}
    </span>
  );
}
