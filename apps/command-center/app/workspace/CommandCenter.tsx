"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIcon,
  AlertIcon,
  CommandIcon,
  CommandPalette,
  CommandRail,
  DashboardIcon,
  LayersIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  useCommandPalette,
  type CommandRailItem,
  type PaletteCommand,
} from "@celastyle/ui";
import { RAIL_ITEMS } from "./data";
import {
  AlertsPanel,
  EvidencePanel,
  GraphPanel,
  NodesPanel,
  OverviewPanel,
  SessionsPanel,
  SettingsPanel,
  SignalsPanel,
  VerifyPanel,
} from "./panels";
import { useEvidenceStream } from "./useEvidenceStream";

const PANEL_ICONS: Record<string, React.ReactNode> = {
  overview: <DashboardIcon />,
  evidence: <ActivityIcon />,
  graph: <LayersIcon />,
  verify: <ServerIcon />,
  nodes: <ServerIcon />,
  sessions: <TerminalIcon />,
  alerts: <AlertIcon />,
  settings: <SettingsIcon />,
};

type Theme = "dark" | "light";

export function CommandCenter() {
  const [activePanel, setActivePanel] = useState("overview");
  const [theme, setTheme] = useState<Theme>("dark");
  const palette = useCommandPalette();

  // One SSE connection shared by every panel that needs the live run. Two
  // panels each opening their own EventSource would run the real gates twice.
  const stream = useEvidenceStream();

  /* The rail badge is the number of gates that did not come back clean, taken
     from the live run. It used to be a literal in RAIL_ITEMS, which meant the
     sidebar reported "2 issues" while a run with six passing gates was on
     screen — a red signal contradicting a green one, with nothing behind
     either. A badge that is not derived from a measurement is decoration that
     looks like telemetry, so the rail now measures the same thing the panel
     does. */
  const issueCount = useMemo(() => {
    const gates = stream.run?.gates;
    if (!gates) return 0;
    return Object.values(gates).filter((g) => g.outcome === "fail" || g.outcome === "review")
      .length;
  }, [stream.run]);

  const items = useMemo<CommandRailItem[]>(
    () =>
      RAIL_ITEMS.map((item) => ({
        ...item,
        icon: PANEL_ICONS[item.id] ?? null,
        // Only the alerts rail reflects real gates. The others still carry
        // placeholder counts from the original mock data, and pretending they
        // are live would recreate the same problem one badge over — so they
        // are left visibly placeholder rather than quietly re-labelled.
        badge: item.id === "alerts" ? issueCount : item.badge,
      })),
    [issueCount],
  );

  /* The palette navigates panels and toggles the theme, so its command list is
     derived from the same state the rail uses — one source of truth. */
  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...RAIL_ITEMS.map((item) => ({
        id: `go-${item.id}`,
        label: `Go to ${item.label}`,
        group: "Navigate",
        keywords: [item.id, "panel", "open"],
        icon: PANEL_ICONS[item.id],
        shortcut: item.shortcut,
        onSelect: () => setActivePanel(item.id),
      })),
      {
        id: "theme-toggle",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        group: "Workspace",
        keywords: ["theme", "light", "dark", "appearance"],
        hint: "appearance",
        onSelect: () => {
          const next = theme === "dark" ? "light" : "dark";
          setTheme(next);
          document.documentElement.setAttribute("data-theme", next);
        },
      },
      {
        id: "new-run",
        label: "Start evidence run",
        group: "Actions",
        keywords: ["run", "evidence", "verify", "ci"],
        icon: <ActivityIcon />,
        shortcut: "⌘R",
        hint: "pipeline",
        onSelect: () => setActivePanel("evidence"),
      },
      {
        id: "review-rejected",
        label: "Review rejected runs",
        group: "Actions",
        keywords: ["reject", "fail", "policy", "audit"],
        icon: <AlertIcon />,
        hint: "policy",
        onSelect: () => setActivePanel("evidence"),
      },
      {
        id: "settings",
        label: "Open settings",
        group: "Workspace",
        keywords: ["preferences", "config"],
        icon: <SettingsIcon />,
        shortcut: "⌘,",
        onSelect: () => setActivePanel("settings"),
      },
    ],
    [theme],
  );

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-surface-canvas">
      <CommandRail
        items={items}
        value={activePanel}
        onValueChange={setActivePanel}
        label="Workspace panels"
        header={
          <span className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-signal text-signal-contrast">
            <CommandIcon size={16} />
          </span>
        }
        footer={<ThemeToggle theme={theme} onToggle={toggleTheme} />}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          activePanel={activePanel}
          onOpenPalette={() => palette.setOpen(true)}
          rate={stream.rate}
        />
        <div className="celastyle-scroll min-h-0 flex-1 p-[var(--panel-gap)]">
          {activePanel === "overview" ? <OverviewPanel /> : null}
          {activePanel === "evidence" ? <EvidencePanel /> : null}
          {activePanel === "graph" ? <GraphPanel stream={stream} /> : null}
          {activePanel === "verify" ? <VerifyPanel stream={stream} /> : null}
          {activePanel === "nodes" ? <NodesPanel /> : null}
          {activePanel === "sessions" ? <SessionsPanel /> : null}
          {activePanel === "alerts" ? <AlertsPanel /> : null}
          {activePanel === "settings" ? <SettingsPanel /> : null}
        </div>
      </main>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        commands={commands}
        placeholder="Search commands, panels, actions…"
      />
    </div>
  );
}

function TopBar({
  activePanel,
  onOpenPalette,
  rate,
}: {
  activePanel: string;
  onOpenPalette: () => void;
  rate: string;
}) {
  const title =
    RAIL_ITEMS.find((item) => item.id === activePanel)?.label ?? "Overview";

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 border-b border-edge-subtle bg-surface-base px-[var(--panel-padding)]">
      <h1 className="text-md font-semibold text-ink-primary">{title}</h1>
      <span className="celastyle-label ml-1 hidden sm:inline">live workspace</span>
      <div className="celastyle-spacer" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-edge-default bg-surface-raised px-2 py-1 text-xs text-ink-tertiary transition-colors hover:border-edge-strong hover:text-ink-primary"
        aria-label="Open command palette"
      >
        <span>Search commands</span>
        <kbd className="rounded-[var(--radius-xs)] bg-surface-inset px-1 font-mono">⌘K</kbd>
      </button>

      <span className="celastyle-live-dot text-[var(--text-2xs)] text-ink-tertiary">
        streaming
      </span>
      {/* Rate measured from the events that actually arrived on this stream.
          The literal it replaced ("12.4k/s") was a mock constant that had no
          relationship to anything on the wire — the same category of claim
          the verification engine was built to remove. A real rate is slower
          than a fake one, and that is the point. */}
      <span className="celastyle-data text-xs text-ink-muted">{rate}</span>
    </header>
  );
}

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-edge-subtle bg-surface-raised text-ink-tertiary transition-colors hover:border-edge-strong hover:text-ink-primary"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      <span
        aria-hidden="true"
        className="block h-3 w-3 rounded-full"
        style={{ background: theme === "dark" ? "#a3e635" : "#65a30d" }}
      />
    </button>
  );
}
