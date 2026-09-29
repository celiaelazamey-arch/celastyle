"use client";

import type { ReactNode } from "react";

/** The four verdicts an evidence run can carry. */
export type EvidenceStatus = "VERIFIED" | "REJECTED" | "PENDING" | "VIOLATION";

type Config = {
  defaultLabel: string;
  /** Full class string, resolved against the token layer via the app's
   *  Tailwind theme bridge. No literal hex: these stay theme-aware. */
  className: string;
  icon: string;
};

export const STATUS_CONFIG: Record<EvidenceStatus, Config> = {
  VERIFIED: {
    defaultLabel: "VERIFIED",
    className:
      "bg-[var(--status-pass-alpha-10)] text-[var(--status-pass)] border-[var(--status-pass-alpha-30)]",
    icon: "✓",
  },
  REJECTED: {
    defaultLabel: "REJECTED",
    className:
      "bg-[var(--status-fail-alpha-10)] text-[var(--status-fail)] border-[var(--status-fail-alpha-30)]",
    icon: "✕",
  },
  PENDING: {
    defaultLabel: "IN_REVIEW",
    className:
      "bg-[var(--status-warn-alpha-10)] text-[var(--status-warn)] border-[var(--status-warn-alpha-30)]",
    icon: "◌",
  },
  VIOLATION: {
    defaultLabel: "POLICY_VIOLATION",
    // Heavier than REJECTED on purpose: a rule was broken, not merely a gate
    // missed, so it gets a denser fill and bold weight.
    className:
      "bg-[var(--status-fail-alpha-10)] text-[var(--status-fail)] border-[var(--status-fail)] font-bold",
    icon: "⚠",
  },
};

export type StatusBadgeProps = {
  status: EvidenceStatus;
  label?: ReactNode;
  size?: "sm" | "md";
  className?: string;
};

/**
 * StatusBadge — the verdict chip on an evidence record.
 *
 * Accessibility note: this deliberately does **not** use `role="status"`.
 * That role is a live region (`aria-live="polite"`), so a list of a dozen
 * badges would make a screen reader announce every one of them on render.
 * A static badge is static markup; if a badge needs to announce a *change*,
 * that is the live region's job, not the badge's.
 *
 * The verdict is also never carried by colour alone — each state has its own
 * glyph and its own word.
 */
export function StatusBadge({
  status,
  label,
  size = "md",
  className,
}: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const sizing = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";

  return (
    <span
      data-status-badge={status}
      className={`inline-flex items-center gap-1.5 rounded-md border font-mono font-semibold uppercase tracking-wider backdrop-blur-md transition-colors ${sizing} ${config.className} ${className ?? ""}`}
    >
      <span aria-hidden="true" className="text-[10px] font-bold">
        {config.icon}
      </span>
      <span>{label ?? config.defaultLabel}</span>
    </span>
  );
}
