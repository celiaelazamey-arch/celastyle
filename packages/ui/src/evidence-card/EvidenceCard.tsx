"use client";

import { StatusBadge } from "../status-badge/StatusBadge";
import { ConstraintTag } from "../constraint-tag/ConstraintTag";
import type { EvidenceCardProps, EvidenceCheck, EvidenceConstraint } from "./types";

/* Each outcome maps to a distinct glyph as well as a colour, so a verdict
   survives greyscale, colour-blindness, and a glance. */
const OUTCOME_MARK: Record<EvidenceCheck["outcome"], string> = {
  pass: "✓",
  fail: "✕",
  run: "◐",
  skip: "—",
};

const OUTCOME_TEXT: Record<EvidenceCheck["outcome"], string> = {
  pass: "pass",
  fail: "fail",
  run: "running",
  skip: "skipped",
};

const OUTCOME_CLASS: Record<EvidenceCheck["outcome"], string> = {
  pass: "text-[var(--status-pass)] bg-[var(--status-pass-alpha-10)]",
  fail: "text-[var(--status-fail)] bg-[var(--status-fail-alpha-10)]",
  run: "text-[var(--accent-lime)] bg-[var(--accent-lime-alpha-10)]",
  skip: "text-[var(--status-info)] bg-[var(--status-info-alpha-10)]",
};

const BAR_CLASS: Record<EvidenceCheck["outcome"], string> = {
  pass: "fill-[var(--status-pass)]",
  fail: "fill-[var(--status-fail)]",
  run: "fill-[var(--accent-lime)]",
  skip: "fill-[var(--status-info)]",
};

function score(checks: readonly EvidenceCheck[]) {
  const scored = checks.filter((c) => c.outcome === "pass" || c.outcome === "fail");
  return {
    passed: scored.filter((c) => c.outcome === "pass").length,
    total: scored.length,
  };
}

function constraintScore(constraints: readonly EvidenceConstraint[]) {
  return {
    passed: constraints.filter((c) => c.state === "satisfied").length,
    total: constraints.length,
  };
}

export function EvidenceCard({
  run,
  chart = true,
  className,
}: EvidenceCardProps) {
  const { passed, total } = score(run.checks);
  const constraints = constraintScore(run.constraints ?? []);
  const anyFail = run.checks.some((c) => c.outcome === "fail");
  const allPass = total > 0 && passed === total;

  const frameClass = anyFail
    ? "border-[var(--status-fail-alpha-30)] hover:border-[var(--status-fail)]"
    : allPass
      ? "border-[var(--status-pass-alpha-30)] hover:border-[var(--status-pass)]"
      : "border-[var(--border-default)] hover:border-[var(--accent-lime)]";

  return (
    <article
      data-run={run.id}
      data-anyfail={anyFail ? "" : undefined}
      data-allpass={allPass ? "" : undefined}
      className={`group relative flex flex-col gap-4 overflow-hidden rounded-xl border bg-[var(--bg-surface)] p-5 text-[var(--text-primary)] shadow-lg backdrop-blur-md transition-all duration-200 ${frameClass} ${className ?? ""}`}
    >
      {/* --- Header rail --- */}
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs uppercase tracking-wider text-[var(--text-dim)]">
            run :: {run.id}
          </span>
          {run.timestamp ? (
            <>
              <span className="text-[var(--text-muted)]">·</span>
              <time className="shrink-0 font-mono text-xs text-[var(--text-dim)]">
                {run.timestamp}
              </time>
            </>
          ) : null}
        </div>
        <StatusBadge status={verdictToStatus(run.verdict)} label={run.verdict} size="sm" />
      </header>

      {/* --- Intent --- */}
      <div>
        <h3 className="line-clamp-2 text-sm font-semibold tracking-tight text-[var(--text-primary)]">
          {run.intent}
        </h3>
        {run.scope ? (
          <p className="mt-1 font-mono text-xs text-[var(--text-dim)]">{run.scope}</p>
        ) : null}
      </div>

      {/* --- Gates --- */}
      <ol
        className="flex flex-col gap-1"
        aria-label={`Evidence gates for run ${run.id}`}
      >
        {run.checks.map((check) => (
          <li
            key={check.id}
            data-outcome={check.outcome}
            className="flex min-h-6 items-center gap-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-0.5"
          >
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${OUTCOME_CLASS[check.outcome]}`}
            >
              {OUTCOME_MARK[check.outcome]}
            </span>
            {/* The glyph is decorative; the outcome is announced as a word. */}
            <span className="sr-only">{OUTCOME_TEXT[check.outcome]}: </span>
            <span className="min-w-[72px] shrink-0 text-xs font-medium text-[var(--text-secondary)]">
              {check.label}
            </span>
            {check.value ? (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                {check.value}
              </span>
            ) : null}
            {check.detail ? (
              <span className="min-w-0 truncate text-right text-[11px] text-[var(--text-dim)]">
                {check.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {/* --- Summary --- */}
      <div className="flex items-center gap-3">
        {chart ? (
          <MiniBarChart
            checks={run.checks}
            label={`${passed} of ${total} gates passed`}
          />
        ) : null}
        <span className="flex shrink-0 items-baseline gap-0.5 font-mono tabular-nums">
          <span
            className={`text-sm font-bold ${
              anyFail
                ? "text-[var(--status-fail)]"
                : allPass
                  ? "text-[var(--status-pass)]"
                  : "text-[var(--text-primary)]"
            }`}
          >
            {passed}
          </span>
          <span className="text-xs text-[var(--text-muted)]">/</span>
          <span className="text-xs text-[var(--text-muted)]">{total}</span>
        </span>
        {constraints.total > 0 ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
            constraints{" "}
            <span className="font-semibold text-[var(--text-secondary)]">
              {constraints.passed}/{constraints.total}
            </span>
          </span>
        ) : null}
      </div>

      {/* --- Constraints --- */}
      {constraints.total > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
            Policy scope verification
          </span>
          {run.constraints?.map((constraint) => (
            <ConstraintTag
              key={constraint.id ?? constraint.rule}
              kind={constraint.kind}
              state={constraint.state}
              value={constraint.value}
            >
              {constraint.rule}
            </ConstraintTag>
          ))}
        </div>
      ) : null}

      {run.children}

      {/* --- Action --- */}
      {run.onInspectGraph ? (
        <div className="flex justify-end border-t border-[var(--border-subtle)] pt-3">
          <button
            type="button"
            onClick={() => run.onInspectGraph?.(run.id)}
            className="rounded px-1 font-mono text-xs font-medium text-[var(--accent-lime)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-lime)]"
          >
            inspect evidence graph <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** Map a free-form verdict word onto the badge's four-state model. */
function verdictToStatus(verdict: string) {
  const v = verdict.toLowerCase();
  if (v.includes("violation")) return "VIOLATION" as const;
  if (v.includes("reject") || v.includes("fail")) return "REJECTED" as const;
  if (v.includes("review") || v.includes("pending") || v.includes("running")) {
    return "PENDING" as const;
  }
  return "VERIFIED" as const;
}

/* -----------------------------------------------------------------------------
 * MiniBarChart
 * One <rect> per gate inside a single SVG, so the outcomes render as an actual
 * bar the eye reads as a whole, and the whole thing announces as one unit.
 * -------------------------------------------------------------------------- */

function MiniBarChart({
  checks,
  label,
}: {
  checks: readonly EvidenceCheck[];
  label: string;
}) {
  const H = 8;
  const GAP = 2;
  const width = 100;
  const barW = checks.length
    ? (width - GAP * (checks.length - 1)) / checks.length
    : width;

  return (
    <svg
      className="h-2 min-w-0 flex-1"
      viewBox={`0 0 ${width} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {checks.map((check, i) => (
        <rect
          key={check.id}
          className={BAR_CLASS[check.outcome]}
          x={i * (barW + GAP)}
          y={0}
          width={barW}
          height={H}
          rx={1.5}
        />
      ))}
    </svg>
  );
}
