import type { ReactNode } from "react";

/**
 * ConstraintTag — a declared rule and whether it currently holds.
 *
 * Three states, not two. `pending` is the state a live evidence view needs
 * most: a rule that has not been evaluated yet is materially different from a
 * rule that passed, and collapsing them into a boolean makes a queued check
 * look like a satisfied one.
 */
export type ConstraintState = "satisfied" | "violated" | "pending";

/** What kind of rule this is. Drives the label, never the colour. */
export type ConstraintKind =
  | "scope"
  | "security"
  | "perf"
  | "compat"
  | "budget"
  | "policy";

export type ConstraintTagProps = {
  /** The rule itself, e.g. "no secrets in build output". */
  children: ReactNode;
  kind?: ConstraintKind;
  state?: ConstraintState;
  /** Short measurement shown on the right, e.g. "1.8s". */
  value?: ReactNode;
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

const STATE_CLASS: Record<ConstraintState, string> = {
  satisfied: "bg-[var(--surface-base)] text-[var(--text-tertiary)] border-[var(--border-subtle)]",
  violated:
    "bg-[var(--status-fail-alpha-10)] text-[var(--status-fail)] border-[var(--status-fail-alpha-30)]",
  pending:
    "bg-[var(--surface-base)] text-[var(--text-muted)] border-[var(--border-subtle)] border-dashed",
};

const STATE_MARK: Record<ConstraintState, string> = {
  satisfied: "✓",
  violated: "✕",
  pending: "◌",
};

const STATE_WORD: Record<ConstraintState, string> = {
  satisfied: "PASS",
  violated: "FAIL",
  pending: "EVAL",
};

export function ConstraintTag({
  children,
  kind = "policy",
  state = "pending",
  value,
  className,
}: ConstraintTagProps) {
  return (
    <div
      data-constraint={state}
      className={`flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 font-mono text-[11px] transition-colors ${STATE_CLASS[state]} ${className ?? ""}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {/* The kind name is the real label; the mark only reinforces the state. */}
        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-widest opacity-70">
          {KIND_LABEL[kind]}
        </span>
        <span className="truncate">{children}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-bold">
        {value ? <span className="font-semibold opacity-90">{value}</span> : null}
        <span aria-hidden="true">{STATE_MARK[state]}</span>
        <span className="sr-only">{STATE_WORD[state]}: </span>
        <span>{STATE_WORD[state]}</span>
      </span>
    </div>
  );
}
