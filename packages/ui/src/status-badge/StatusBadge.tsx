import { cn } from "../lib/cn";
import type { StatusBadgeProps } from "./types";
import "./status-badge.css";

/**
 * StatusBadge — the unit of verdict in an evidence UI.
 *
 * Two rules it enforces for you:
 *  1. Tone resolves to a `--status-*` triplet, so a badge never needs a
 *     theme-specific colour branch.
 *  2. `live` is mutually exclusive with `dot`; asking for both would render two
 *     indicators saying the same thing.
 */
export function StatusBadge({
  children,
  tone = "neutral",
  variant = "subtle",
  size = "sm",
  dot = false,
  live = false,
  icon,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn("cs-badge", className)}
      data-tone={tone}
      data-variant={variant}
      data-size={size}
    >
      {live ? (
        <span className="cs-badge__live" aria-hidden="true" />
      ) : dot ? (
        <span className="cs-badge__dot" aria-hidden="true" />
      ) : null}
      {icon ? (
        <span className="cs-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="cs-badge__label">{children}</span>
    </span>
  );
}
