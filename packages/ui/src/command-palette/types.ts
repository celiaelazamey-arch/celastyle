import type { ReactNode } from "react";

/** A single palette action. */
export type PaletteCommand = {
  id: string;
  label: string;
  /** Grouping header — commands are rendered in contiguous runs. */
  group: string;
  /** Extra searchable terms not present in the label. */
  keywords?: string[];
  /** Rendered before the label, e.g. an icon. */
  icon?: ReactNode;
  /** Right-aligned hint, e.g. "⌘⇧P". */
  shortcut?: string;
  /** Small trailing note. */
  hint?: string;
  onSelect?: () => void;
};

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly PaletteCommand[];
  placeholder?: string;
  label?: string;
  emptyMessage?: string;
};
