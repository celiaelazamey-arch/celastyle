"use client";

import { useState } from "react";
import { CompactCard, TerminalIcon } from "@celastyle/ui";
import {
  ALERTS,
  NODES,
  OVERVIEW_STATS,
  SESSIONS,
  SIGNALS,
} from "./data";

/* -----------------------------------------------------------------------------
 * Panels
 *
 * Each panel is the same shape — a bordered unit that owns its own scroll. The
 * interesting part is that none of them declare a colour: every status, border
 * and surface comes from the semantic tokens, so the light/dark switch needs no
 * per-panel branch.
 * -------------------------------------------------------------------------- */

export function OverviewPanel() {
  const [selected, setSelected] = useState<string | null>("sig-3");

  return (
    <div className="grid grid-cols-2 gap-[var(--panel-gap)] lg:grid-cols-4">
      {OVERVIEW_STATS.map((stat) => (
        <div className="cc-stat" key={stat.label}>
          <span className="celastyle-label">{stat.label}</span>
          <span className="cc-stat__value">
            {stat.value}
            {stat.unit ? (
              <span className="cc-stat__unit"> {stat.unit}</span>
            ) : null}
          </span>
          {stat.delta ? (
            <span
              className={`cc-stat__delta cc-stat__delta--${stat.direction ?? "up"}`}
            >
              {stat.direction === "down" ? "▲" : "▼"} {stat.delta}
              <span className="text-ink-muted">vs 1h ago</span>
            </span>
          ) : null}
        </div>
      ))}

      <div className="cc-panel col-span-2 lg:col-span-4">
        <div className="cc-panel__header">
          <h2 className="cc-panel__title">Recent signals</h2>
          <div className="celastyle-spacer" />
          <span className="celastyle-label">last 90 minutes</span>
        </div>
        <div className="cc-panel__body flex flex-col gap-[var(--card-gap)]">
          {SIGNALS.slice(0, 4).map((signal) => (
            <CompactCard
              key={signal.id}
              title={signal.title}
              status={signal.status}
              meta={signal.time}
              selected={selected === signal.id}
              onClick={() => setSelected(signal.id)}
              data={[
                { label: "src", value: signal.source },
                { label: "target", value: signal.target, highlight: true },
              ]}
            >
              {signal.body}
            </CompactCard>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SignalsPanel() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="cc-panel">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Signal feed</h2>
        <span className="celastyle-badge bg-signal-soft text-signal">
          {SIGNALS.length}
        </span>
        <div className="celastyle-spacer" />
        <span className="celastyle-live-dot text-[var(--text-2xs)] text-ink-tertiary">
          live
        </span>
      </div>

      <div className="cc-panel__body flex flex-col gap-[var(--card-gap)]">
        {SIGNALS.map((signal) => (
          <CompactCard
            key={signal.id}
            title={signal.title}
            status={signal.status}
            meta={signal.time}
            selected={selected === signal.id}
            onClick={() => setSelected(signal.id)}
            data={[
              { label: "source", value: signal.source },
              { label: "target", value: signal.target, highlight: true },
            ]}
            trailing={
              signal.highlight ? (
                <span className="celastyle-label text-signal">priority</span>
              ) : null
            }
          >
            {signal.body}
          </CompactCard>
        ))}
      </div>
    </div>
  );
}

export function NodesPanel() {
  const [selected, setSelected] = useState<string | null>("edge-ap-south-1-a");

  return (
    <div className="cc-panel">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Fleet</h2>
        <div className="celastyle-spacer" />
        <span className="celastyle-label">{NODES.length} nodes</span>
      </div>

      {/* Grid at wide widths so the fleet can be scanned by column, list on
          narrow ones so a row never truncates its own data lane. */}
      <div className="cc-panel__body grid grid-cols-1 gap-[var(--card-gap)] xl:grid-cols-2">
        {NODES.map((node) => (
          <CompactCard
            key={node.id}
            title={node.id}
            icon={<TerminalIcon />}
            status={node.status}
            selected={selected === node.id}
            onClick={() => setSelected(node.id)}
            meta={node.region}
            data={[
              { label: "cpu", value: node.cpu },
              { label: "mem", value: node.mem },
              {
                label: "up",
                value: node.uptime,
                highlight: node.status !== "success",
              },
            ]}
          />
        ))}
      </div>
    </div>
  );
}

export function SessionsPanel() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="cc-panel">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Active sessions</h2>
        <div className="celastyle-spacer" />
        <span className="celastyle-label">{SESSIONS.length} open</span>
      </div>

      <div className="cc-panel__body flex flex-col gap-[var(--card-gap)]">
        {SESSIONS.map((session) => (
          <CompactCard
            key={session.id}
            title={session.title}
            status={session.status}
            density="comfortable"
            selected={selected === session.id}
            onClick={() => setSelected(session.id)}
            badge={session.id}
            data={[
              { label: "owner", value: session.actor },
              { label: "started", value: session.started },
              { label: "for", value: session.duration },
            ]}
          />
        ))}
      </div>
    </div>
  );
}

export function AlertsPanel() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="cc-panel">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Open alerts</h2>
        <div className="celastyle-spacer" />
        <span className="celastyle-label">{ALERTS.length} unacknowledged</span>
      </div>

      <div className="cc-panel__body flex flex-col gap-[var(--card-gap)]">
        {ALERTS.map((alert) => (
          <CompactCard
            key={alert.id}
            title={alert.title}
            /* Tinted here because every alert is already a narrowed field —
               the row is an exception, so a dot alone would under-signal it. */
            tint
            status={alert.status}
            selected={selected === alert.id}
            onClick={() => setSelected(alert.id)}
            badge={alert.severity}
            meta={alert.time}
            data={[{ label: "owner", value: alert.owner, highlight: true }]}
          >
            {alert.body}
          </CompactCard>
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");
  const [reduceMotion, setReduceMotion] = useState(false);

  return (
    <div className="cc-panel max-w-2xl">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Workspace settings</h2>
      </div>

      <div className="cc-panel__body flex flex-col gap-4">
        <SettingRow
          label="Card density"
          hint="Controls the padding scale used by every Compact Card."
        >
          <SegmentedControl
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </SettingRow>

        <SettingRow
          label="Reduce motion"
          hint="Stops the live-indicator breath and skeleton shimmer."
        >
          <Switch
            checked={reduceMotion}
            onChange={setReduceMotion}
            label="Reduce motion"
          />
        </SettingRow>

        <SettingRow
          label="Preview"
          hint="The same card rendered at the density selected above."
        >
          <div className="w-full">
            <CompactCard
              title="edge-us-east-1-a"
              status="warning"
              density={density}
              data={[
                { label: "cpu", value: "78%" },
                { label: "mem", value: "82%", highlight: true },
              ]}
            >
              Rendered at {density} density to preview the setting.
            </CompactCard>
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge-subtle pb-4 last:border-b-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-primary">{label}</div>
        <p className="mt-1 text-xs text-ink-tertiary">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex shrink-0 gap-0.5 rounded-[var(--radius-sm)] border border-edge-default bg-surface-inset p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`cursor-pointer rounded-[var(--radius-xs)] px-2.5 py-1 text-xs font-medium transition-colors ${
            value === option.value
              ? "bg-signal text-signal-contrast"
              : "text-ink-tertiary hover:text-ink-primary"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
        checked
          ? "border-signal bg-signal"
          : "border-edge-default bg-surface-inset"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-[left] duration-150 ${
          checked
            ? "left-[18px] bg-signal-contrast"
            : "left-0.5 bg-ink-muted"
        }`}
      />
    </button>
  );
}
