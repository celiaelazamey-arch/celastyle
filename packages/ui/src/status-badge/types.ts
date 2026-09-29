import type { ReactNode } from "react";

/** Semantic tone. Maps onto the `--status-*` token triplets, never onto a raw
 *  colour — that is what keeps badges legible in both themes. */
export type StatusBadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

/**
 * Visual weight.
 *  - `subtle`  tinted fill, tone-coloured text. The default: at the density of
 *              an evidence card, several solid badges turn the row into a
 *              colour block.
 *  - `solid`   filled. Reserve for the single most important state on screen.
 *  - `outline` hairline only, for dense lists where even a tint is too much.
 */
export type StatusBadgeVariant = "subtle" | "solid" | "outline";

export type StatusBadgeSize = "sm" | "md";

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusBadgeTone;
  variant?: StatusBadgeVariant;
  size?: StatusBadgeSize;
  /** Leading dot. Omit when the label alone is unambiguous. */
  dot?: boolean;
  /** Pulsing dot — "this is being evaluated right now". */
  live?: boolean;
  icon?: ReactNode;
  className?: string;
};
