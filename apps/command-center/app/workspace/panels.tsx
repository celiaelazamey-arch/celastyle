"use client";

import { useMemo, useState } from "react";
import {
  CompactCard,
  EvidenceCard,
  EvidenceGraph,
  PolicyPanel,
  StatusBadge,
  TerminalIcon,
  type GraphEdge,
  type GraphNode,
} from "@celastyle/ui";
import { ALERTS, NODES, OVERVIEW_STATS, SESSIONS, SIGNALS } from "./data";
import { EVIDENCE_SUMMARY, POLICY_RULES, RUNS } from "./evidence";
import { projectRun } from "./projectRun";
import { useEvidenceStream } from "./useEvidenceStream";

/* =============================================================================
   Panels
   ============================================================================= */

export function OverviewPanel() {
  const [selected, setSelected] = useState<string | null>("sig-3");

  return (
    <div className="grid grid-cols-2 gap-[var(--panel-gap)] lg:grid-cols-4">
      {OVERVIEW_STATS.map((stat) => (
        <div className="cc-stat" key={stat.label}>
          <span className="celastyle-label">{stat.label}</span>
          <span className="cc-stat__value">
            {stat.value}
            {stat.unit ? <span className="cc-stat__unit"> {stat.unit}</span> : null}
          </span>
          {stat.delta ? (
            <span className={`cc-stat__delta cc-stat__delta--${stat.direction ?? "up"}`}>
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
        <span className="celastyle-label text-signal">{SIGNALS.length}</span>
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
            trailing={signal.highlight ? <span className="celastyle-label text-signal">priority</span> : null}
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
              { label: "up", value: node.uptime, highlight: node.status !== "success" },
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

/* =============================================================================
   Evidence panel — the evidence-first surface
   ============================================================================= */

export function EvidencePanel() {
  const [inspecting, setInspecting] = useState<string | null>(null);

  const activeRun = RUNS.find((r) => r.id === inspecting) ?? null;
  const rules = inspecting ? (POLICY_RULES[inspecting] ?? []) : [];

  return (
    <div className="flex min-h-0 flex-col gap-[var(--panel-gap)]">
      <div className="celastyle-scroll min-h-0 flex-1">
        <div className="flex flex-col gap-[var(--panel-gap)]">
          {/* Summary chips */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status="VERIFIED"
              label={`${EVIDENCE_SUMMARY.verified} verified`}
            />
            <StatusBadge
              status="REJECTED"
              label={`${EVIDENCE_SUMMARY.rejected} rejected`}
            />
            <StatusBadge
              status="PENDING"
              label={`${EVIDENCE_SUMMARY.inFlight} in flight`}
            />
            <div className="celastyle-spacer" />
            <span className="celastyle-label">evidence graph</span>
          </div>

          {RUNS.map((run) => (
            <EvidenceCard
              key={run.id}
              run={{ ...run, onInspectGraph: setInspecting }}
            />
          ))}
        </div>
      </div>

      {/* Policy slide-over — adjudicates whichever run was inspected. */}
      <PolicyPanel
        isOpen={activeRun !== null}
        onClose={() => setInspecting(null)}
        taskTitle={activeRun ? `${activeRun.id} · ${activeRun.intent}` : ""}
        overallStatus={
          activeRun?.tone === "success"
            ? "VERIFIED"
            : activeRun?.tone === "danger"
              ? "REJECTED"
              : "PENDING"
        }
        rules={rules}
        footer={
          activeRun ? (
            <span className="font-mono text-[10px] text-[var(--text-dim)]">
              run {activeRun.id} · {activeRun.duration}
            </span>
          ) : null
        }
      />
    </div>
  );
}

/* =============================================================================
   Graph panel — the live evidence DAG fed by the telemetry stream.
   ============================================================================= */

export function GraphPanel() {
  const { run, status } = useEvidenceStream();
  const [selected, setSelected] = useState<string | null>(null);

  // The projection (live run → graph nodes/edges) is shared with its test via
  // projectRun, so it is exercised directly rather than reimplemented here.
  const { nodes, edges } = useMemo(
    () => (run ? projectRun(run) : { nodes: [] as GraphNode[], edges: [] as GraphEdge[] }),
    [run],
  );

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-[var(--panel-gap)]">
      <div className="cc-panel flex min-h-0 flex-1 flex-col">
        <div className="cc-panel__header">
          <h2 className="cc-panel__title">Evidence graph</h2>
          <div className="celastyle-spacer" />
          <span
            className="celastyle-live-dot text-[var(--text-2xs)] text-ink-tertiary"
            data-status={status}
          >
            {status === "live" ? "streaming" : status}
          </span>
        </div>
        <div className="cc-panel__body min-h-0 flex-1 overflow-x-auto">
          {run ? (
            <EvidenceGraph
              nodes={nodes}
              edges={edges}
              selectedId={selected}
              onSelect={(id) => setSelected((s) => (s === id ? null : id))}
              label={`Live evidence graph for run ${run.runId}`}
            />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-xs text-[var(--text-muted)]">
              connecting to telemetry…
            </div>
          )}
        </div>
        {selectedNode ? (
          <div className="border-t border-[var(--border-subtle)] px-[var(--panel-padding)] py-3">
            <div className="flex items-center gap-2">
              <span className="celastyle-label">selected node</span>
              <span className="font-mono text-xs text-[var(--text-primary)]">
                {selectedNode.label}
              </span>
              <StatusBadge
                status={
                  selectedNode.status === "pass"
                    ? "VERIFIED"
                    : selectedNode.status === "fail"
                      ? "REJECTED"
                      : "PENDING"
                }
                size="sm"
                label={selectedNode.status}
              />
            </div>
            {selectedNode.detail ? (
              <p className="mt-1 font-mono text-[11px] text-[var(--text-dim)]">
                {selectedNode.detail}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");

  return (
    <div className="cc-panel max-w-2xl">
      <div className="cc-panel__header">
        <h2 className="cc-panel__title">Workspace settings</h2>
      </div>
      <div className="cc-panel__body flex flex-col gap-4">
        <SettingRow label="Card density" hint="Padding scale for every Compact Card.">
          <SegmentedControl
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </SettingRow>
        <SettingRow label="Preview" hint="The same card at the selected density.">
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
              Rendered at {density} density.
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
