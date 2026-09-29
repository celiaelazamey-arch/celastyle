"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIcon,
  AlertIcon,
  CommandIcon,
  CommandRail,
  DashboardIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  type CommandRailItem,
} from "@celastyle/ui";
import { RAIL_ITEMS } from "./data";
import {
  AlertsPanel,
  NodesPanel,
  OverviewPanel,
  SessionsPanel,
  SettingsPanel,
  SignalsPanel,
} from "./panels";

/* Icons live here rather than in the fixture module so the data stays
   serialisable and the component tree owns what it renders. */
const PANEL_ICONS: Record<string, React.ReactNode> = {
  overview: <DashboardIcon />,
  signals: <ActivityIcon />,
  nodes: <ServerIcon />,
  sessions: <TerminalIcon />,
  alerts: <AlertIcon />,
  settings: <SettingsIcon />,
};

type Theme = "dark" | "light";

export function CommandCenter() {
  const [activePanel, setActivePanel] = useState("overview");
  const [theme, setTheme] = useState<Theme>("dark");

  const items = useMemo<CommandRailItem[]>(
    () =>
      RAIL_ITEMS.map((item) => ({
        ...item,
        icon: PANEL_ICONS[item.id] ?? null,
      })),
    [],
  );

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      // The token map lives on <html>, so flipping this one attribute re-themes
      // the rail, the panels and every Tailwind colour utility at once.
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
        <TopBar activePanel={activePanel} />
        <div className="celastyle-scroll min-h-0 flex-1 p-[var(--panel-gap)]">
          {activePanel === "overview" ? <OverviewPanel /> : null}
          {activePanel === "signals" ? <SignalsPanel /> : null}
          {activePanel === "nodes" ? <NodesPanel /> : null}
          {activePanel === "sessions" ? <SessionsPanel /> : null}
          {activePanel === "alerts" ? <AlertsPanel /> : null}
          {activePanel === "settings" ? <SettingsPanel /> : null}
        </div>
      </main>
    </div>
  );
}

function TopBar({ activePanel }: { activePanel: string }) {
  const title =
    RAIL_ITEMS.find((item) => item.id === activePanel)?.label ?? "Overview";

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 border-b border-edge-subtle bg-surface-base px-[var(--panel-padding)]">
      <h1 className="text-md font-semibold text-ink-primary">{title}</h1>

      <span className="celastyle-label ml-1 hidden sm:inline">
        live workspace
      </span>

      <div className="celastyle-spacer" />

      <span className="celastyle-live-dot text-[var(--text-2xs)] text-ink-tertiary">
        streaming
      </span>
      <span className="celastyle-data text-xs text-ink-muted">12.4k/s</span>
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
        style={{
          background: theme === "dark" ? "#a3e635" : "#65a30d",
        }}
      />
    </button>
  );
}
