"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "../status-badge/StatusBadge";

import type { PolicyPanelProps } from "./types";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * PolicyPanel — the slide-over that adjudicates a run.
 *
 * Rendered through a portal so it is never clipped by a panel's `overflow`, and
 * so it escapes the workspace rail's stacking context.
 *
 * Modal behaviour implemented here, not assumed:
 *  - Escape closes, from a `keydown` listener on the document (so it works
 *    regardless of where focus currently sits inside the panel).
 *  - Tab is trapped: focus cycles within the panel, and cannot escape to the
 *    workspace behind the scrim.
 *  - On open, focus moves to the panel; on close, focus returns to whatever
 *    opened it. Without that return, keyboard users are dropped at the top of
 *    the document with no idea where they were.
 *  - The scrim is `aria-hidden`; `aria-modal` on the panel is what tells AT
 *    the content behind is inert.
 */
export function PolicyPanel({
  isOpen,
  onClose,
  taskTitle,
  overallStatus,
  rules,
  statusLabel = "Gate Status",
  footer,
}: PolicyPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // A portal cannot render before the document exists.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Remember the trigger, and restore focus to it on close.
  useEffect(() => {
    if (isOpen) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      const panel = panelRef.current;
      panel?.focus();
    } else {
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    }
  }, [isOpen]);

  // Escape + Tab trap.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!mounted || !isOpen) return null;

  const requiredRules = rules.filter((r) => r.requiredForRelease);
  const requiredPassed = requiredRules.filter((r) => r.passed).length;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex justify-end bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Policy decision engine for ${taskTitle}`}
        tabIndex={-1}
        className="flex h-full w-full max-w-lg flex-col border-l border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-2xl outline-none motion-safe:animate-[celastyle-slide-in_var(--duration-normal)_var(--ease-standard)]"
      >
        {/* --- Header --- */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] p-6 pb-4">
          <div className="min-w-0">
            <h3 className="font-mono text-base font-semibold text-[var(--text-primary)]">
              Policy Decision Engine
            </h3>
            <p className="mt-0.5 truncate font-sans text-xs text-[var(--text-dim)]">
              {taskTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-lime)]"
            aria-label="Close policy panel"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* --- Gate status --- */}
        <div className="my-5 flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-4">
          <span className="font-mono text-xs text-[var(--text-dim)]">{statusLabel}</span>
          <StatusBadge status={overallStatus} />
        </div>

        {/* --- Release gate --- */}
        {requiredRules.length > 0 ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
              Release-blocking
            </span>
            <span className="font-mono text-xs font-semibold tabular-nums text-[var(--text-primary)]">
              {requiredPassed}/{requiredRules.length} passed
            </span>
          </div>
        ) : null}

        {/* --- Rules --- */}
        <div className="celastyle-scroll min-h-0 flex-1 pr-1">
          <h4 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
            Evaluation rules
          </h4>
          <ul className="flex flex-col gap-3">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={`rounded-lg border p-3.5 text-xs ${
                  rule.passed
                    ? "border-[var(--status-pass-alpha-30)] bg-[var(--status-pass-alpha-10)]"
                    : "border-[var(--status-fail-alpha-30)] bg-[var(--status-fail-alpha-10)]"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 font-bold ${
                      rule.passed
                        ? "text-[var(--status-pass)]"
                        : "text-[var(--status-fail)]"
                    }`}
                  >
                    {rule.passed ? "✓" : "✕"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono font-semibold text-[var(--text-primary)]">
                        {rule.name}
                      </span>
                      {rule.requiredForRelease ? (
                        <span className="shrink-0 rounded border border-[var(--status-warn-alpha-30)] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[var(--status-warn)]">
                          required
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 font-sans text-[11px] text-[var(--text-dim)]">
                      {rule.description}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* --- Footer --- */}
        <div className="mt-auto flex items-center justify-end gap-3 border-t border-[var(--border-subtle)] p-6 pt-4">
          {footer}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border-subtle)] px-4 py-2 font-mono text-xs text-[var(--text-dim)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-lime)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
