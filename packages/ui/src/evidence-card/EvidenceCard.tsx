import { StatusBadge } from "../status-badge/StatusBadge";
import { ConstraintTag } from "../constraint-tag/ConstraintTag";
import { cn } from "../lib/cn";
import type { CheckOutcome, EvidenceCardProps } from "./types";
import "./evidence-card.css";

/* A short word is not enough to carry an outcome — "run" and "skip" in
   particular are easy to misread. Each maps to a distinct glyph AND a CSS
   `data-outcome` tone, so the meaning survives greyscale, colour-blindness,
   and a glance. */
const OUTCOME_MARK: Record<CheckOutcome, string> = {
  pass: "✓",
  fail: "✕",
  run: "◐",
  skip: "—",
};

function score(checks: readonly { outcome: CheckOutcome }[]) {
  const scored = checks.filter(
    (c) => c.outcome === "pass" || c.outcome === "fail",
  );
  const passed = scored.filter((c) => c.outcome === "pass").length;
  return { passed, total: scored.length };
}

export function EvidenceCard({ run, chart = true, className }: EvidenceCardProps) {
  const { passed, total } = score(run.checks);
  const allPass = total > 0 && passed === total;
  const anyFail = run.checks.some((c) => c.outcome === "fail");

  return (
    <article
      className={cn("cs-evidence", className)}
      data-allpass={allPass ? "" : undefined}
      data-anyfail={anyFail ? "" : undefined}
    >
      {/* --- Header: intent, scope, verdict --- */}
      <header className="cs-evidence__header">
        <div className="cs-evidence__heading">
          <h3 className="cs-evidence__intent">{run.intent}</h3>
          {run.scope ? (
            <p className="cs-evidence__scope">{run.scope}</p>
          ) : null}
        </div>
        <StatusBadge tone={run.tone} size="md">
          {run.verdict}
        </StatusBadge>
      </header>

      {/* --- Checks: the five gates, one per stage --- */}
      <ol className="cs-evidence__checks" aria-label="Evidence checks">
        {run.checks.map((check) => (
          <li
            className="cs-check"
            key={check.id}
            data-outcome={check.outcome}
          >
            <span className="cs-check__mark" aria-hidden="true">
              {OUTCOME_MARK[check.outcome]}
            </span>
            <span className="cs-check__label">{check.label}</span>
            {check.value ? (
              <span className="cs-check__value">{check.value}</span>
            ) : null}
            {check.detail ? (
              <span className="cs-check__detail">{check.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {/* --- Mini chart: pass/fail bar + score --- */}
      {chart ? (
        <div className="cs-evidence__summary">
          <MiniBarChart
            checks={run.checks.map((c) => c.outcome)}
            label={`${passed} of ${total} checks passed`}
          />
          <span className="cs-evidence__score">
            <span className="cs-evidence__score-num">{passed}</span>
            <span className="cs-evidence__score-sep">/</span>
            <span className="cs-evidence__score-total">{total}</span>
          </span>
        </div>
      ) : null}

      {run.constraints && run.constraints.length > 0 ? (
        <div className="cs-evidence__constraints">
          {run.constraints.map((constraint) => (
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

      {run.children ? (
        <div className="cs-evidence__extra">{run.children}</div>
      ) : null}
    </article>
  );
}

/* -----------------------------------------------------------------------------
 * MiniBarChart
 * A real SVG, not a row of styled divs: it is one `<rect>` per check, so the
 * five outcomes render as an actual bar the eye can read as a whole, and it
 * collapses to a single scaleable element.
 * -------------------------------------------------------------------------- */

function MiniBarChart({
  checks,
  label,
}: {
  checks: CheckOutcome[];
  label: string;
}) {
  const H = 8;
  const GAP = 2;
  const width = 100;

  return (
    <svg
      className="cs-evidence__chart"
      viewBox={`0 0 ${width} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {checks.map((outcome, i) => {
        const barW = checks.length > 0 ? (width - GAP * (checks.length - 1)) / checks.length : width;
        const x = i * (barW + GAP);
        return (
          <rect
            key={i}
            className="cs-evidence__bar"
            data-outcome={outcome}
            x={x}
            y={0}
            width={barW}
            height={H}
            rx={1.5}
          />
        );
      })}
    </svg>
  );
}
