/* =============================================================================
   @celastyle/ui — public surface
   -----------------------------------------------------------------------------
   Import the stylesheet once, at the app root:

     import "@celastyle/ui/styles.css";

   It pulls in @celastyle/tokens first, so the semantic layer — and the
   surface aliases the evidence patterns reference — is guaranteed to exist
   before any utility that resolves them.

   Tailwind note: the evidence patterns are written with utility classes and
   arbitrary values, e.g. `bg-[var(--bg-surface)]`. That works without a
   Tailwind theme block, but a consumer must ensure Tailwind *scans* this
   package, otherwise the utilities are never generated. In Tailwind v4 that
   means pointing the source root at node_modules:

     @import "tailwindcss" source(none);
     @source "../../node_modules/@celastyle/ui/src";
   ========================================================================== */

/* --- Command Rail --- */
export { CommandRail } from "./command-rail/CommandRail";
export type {
  CommandRailItem,
  CommandRailMode,
  CommandRailProps,
} from "./command-rail/types";

/* --- Compact Card --- */
export { CompactCard } from "./compact-card/CompactCard";
export type {
  CompactCardDatum,
  CompactCardDensity,
  CompactCardProps,
  CompactCardStatus,
} from "./compact-card/types";

/* --- Evidence patterns --- */
export { StatusBadge, STATUS_CONFIG, type EvidenceStatus, type StatusBadgeProps } from "./status-badge/StatusBadge";
export {
  ConstraintTag,
  type ConstraintKind,
  type ConstraintState,
  type ConstraintTagProps,
} from "./constraint-tag/ConstraintTag";

export { EvidenceCard } from "./evidence-card/EvidenceCard";
export type {
  CheckOutcome,
  EvidenceCardProps,
  EvidenceCheck,
  EvidenceConstraint,
  EvidenceRun,
} from "./evidence-card/types";
export {
  deriveTone,
  toEvidenceChecks,
  type EvidenceMetrics,
  type GateResult,
} from "./evidence-card/metrics";

export { PolicyPanel } from "./policy-panel/PolicyPanel";
export type { PolicyPanelProps, PolicyRule } from "./policy-panel/types";

/* --- Evidence graph --- */
export { EvidenceGraph } from "./evidence-graph/EvidenceGraph";
export type {
  EvidenceGraphProps,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphNodeStatus,
} from "./evidence-graph/types";
export {
  layoutGraph,
  NODE_WIDTH,
  NODE_HEIGHT,
  type Layout,
  type PositionedNode,
} from "./evidence-graph/layout";

export {
  CommandPalette,
  useCommandPalette,
} from "./command-palette/CommandPalette";
export type { CommandPaletteProps, PaletteCommand } from "./command-palette/types";

/* --- Primitives --- */
export { Icon, type IconProps } from "./primitives/Icon";
export {
  ActivityIcon,
  AlertIcon,
  BellIcon,
  ChevronRightIcon,
  CommandIcon,
  DashboardIcon,
  LayersIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
} from "./primitives/icons";

/* --- Utilities --- */
export { cn, type ClassValue } from "./lib/cn";
