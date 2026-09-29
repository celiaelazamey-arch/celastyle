import type { ReactNode } from "react";

/** A single destination in the Command Rail. */
export type CommandRailItem = {
  /** Stable identifier. Also used to derive the React key and panel id. */
  id: string;
  /** Visible name. Present in the DOM at all times, so it doubles as the
   *  accessible name and as the tooltip in icon-only mode. */
  label: string;
  /** Leading glyph. Should be an `Icon` from this package. */
  icon?: ReactNode;
  /** Trailing count/notice. Rendered as a pill; omitted when 0 or undefined. */
  badge?: number | string;
  /** Keyboard hint surfaced in the tooltip, e.g. "⌘1" or "G then O". */
  shortcut?: string;
  /** Id of the panel this item controls, for `aria-controls`. */
  panelId?: string;
  disabled?: boolean;
};

export type CommandRailMode = "icon" | "expanded";

export type CommandRailProps = {
  items: readonly CommandRailItem[];
  /** Controlled selection. */
  value?: string;
  /** Initial selection when uncontrolled. Defaults to the first enabled item. */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /**
   * "icon" (default) is a 56px icon rail where the label appears as a tooltip
   * on hover/focus. "expanded" keeps labels inline at a wider rail.
   */
  mode?: CommandRailMode;
  /** Accessible name for the landmark, e.g. "Workspace panels". */
  label?: string;
  /** Pinned to the top of the item stack, after any section headers. */
  header?: ReactNode;
  /** Pinned to the bottom of the rail, above `footer`. */
  footer?: ReactNode;
  className?: string;
};
