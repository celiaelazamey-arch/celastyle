import type { ReactNode } from "react";

/** Severity of a card. Drives the leading dot and the optional tint. */
export type CompactCardStatus =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** How tightly the card packs. "compact" is the command-center default. */
export type CompactCardDensity = "compact" | "comfortable";

/** A label/value pair rendered in the card's monospace data lane. */
export type CompactCardDatum = {
  label: string;
  value: string;
  /** Render in the accent color — for the value that matters most. */
  highlight?: boolean;
};

export type CompactCardProps = {
  /** Primary line. When `onClick` is set this becomes the card's trigger. */
  title: string;
  /** Trailing metadata — a timestamp, a relative time, a source. */
  meta?: ReactNode;
  /** Short pill beside the title. */
  badge?: ReactNode;
  /** Leading glyph or avatar, before the status dot. */
  icon?: ReactNode;
  /** Slot after the meta line. Kept above the card's click target so it can
   *  hold its own interactive controls. */
  trailing?: ReactNode;
  status?: CompactCardStatus;
  density?: CompactCardDensity;
  /** Tint the whole card with the status color instead of only the dot. */
  tint?: boolean;
  /** Render a static label/value row beneath the body. */
  data?: readonly CompactCardDatum[];
  /** Makes the whole card a click target. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Renders the card as selected — used for the current row in a list. */
  selected?: boolean;
  className?: string;
  children?: ReactNode;
};
