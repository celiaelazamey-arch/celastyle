/* =============================================================================
   @celastyle/ui — public surface
   -----------------------------------------------------------------------------
   Import the stylesheet once, at the app root:

     import "@celastyle/ui/styles.css";

   It pulls in @celastyle/tokens first, so the semantic layer is guaranteed to
   be present before any component rule that references it.
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
