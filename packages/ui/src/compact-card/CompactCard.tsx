import type { MouseEvent } from "react";
import { cn } from "../lib/cn";
import type { CompactCardProps } from "./types";
import "./compact-card.css";

/**
 * Compact Card — the dense row used for messages, events and item summaries.
 *
 * Interaction uses the stretched-trigger pattern: the title renders as a real
 * `<button>` whose `::after` covers the whole card, rather than putting
 * `role="button"` on the card itself. That keeps the semantics honest (it is a
 * button, so it is in the tab order with a real accessible name) while leaving
 * the card free to contain other controls in `trailing` — which a
 * role="button" wrapper would otherwise swallow or make invalid.
 */
export function CompactCard({
  title,
  meta,
  badge,
  icon,
  trailing,
  status = "neutral",
  density = "compact",
  tint = false,
  data,
  onClick,
  selected = false,
  className,
  children,
}: CompactCardProps) {
  const hasStatus = status !== "neutral";

  const handleClick = onClick
    ? (event: MouseEvent<HTMLButtonElement>) => onClick(event)
    : undefined;

  return (
    <article
      className={cn("cs-card", className)}
      data-status={hasStatus ? status : undefined}
      data-density={density}
      data-tint={tint && hasStatus ? "" : undefined}
      data-interactive={onClick ? "" : undefined}
      data-selected={selected ? "" : undefined}
    >
      <header className="cs-card__header">
        {icon ? (
          <span className="cs-card__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}

        {hasStatus ? (
          <span
            className="cs-card__dot"
            data-status={status}
            aria-hidden="true"
          />
        ) : null}

        <h3 className="cs-card__title">
          {onClick ? (
            <button type="button" className="cs-card__action" onClick={handleClick}>
              {title}
            </button>
          ) : (
            title
          )}
        </h3>

        {badge ? <span className="cs-card__badge">{badge}</span> : null}

        {meta ? <span className="cs-card__meta">{meta}</span> : null}
      </header>

      {children ? <div className="cs-card__body">{children}</div> : null}

      {data && data.length > 0 ? (
        <dl className="cs-card__data">
          {data.map((datum) => (
            <div className="cs-card__datum" key={datum.label}>
              <dt className="cs-card__datum-label">{datum.label}</dt>
              <dd
                className="cs-card__datum-value"
                data-highlight={datum.highlight ? "" : undefined}
              >
                {datum.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {trailing ? <div className="cs-card__trailing">{trailing}</div> : null}
    </article>
  );
}
