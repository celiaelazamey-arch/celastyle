import type {
  CommandRailItem,
  CompactCardStatus,
} from "@celastyle/ui";

/* -----------------------------------------------------------------------------
 * Fixture data.
 *
 * Stands in for a live feed so the components can be exercised against
 * realistic density: long titles, uneven payload lengths, mixed severities,
 * and values that sit next to each other in a column and must stay aligned.
 * -------------------------------------------------------------------------- */

export const PANEL_IDS = {
  overview: "panel-overview",
  evidence: "panel-evidence",
  graph: "panel-graph",
  verify: "panel-verify",
  signals: "panel-signals",
  nodes: "panel-nodes",
  sessions: "panel-sessions",
  alerts: "panel-alerts",
  settings: "panel-settings",
} as const;

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS];

export const RAIL_ITEMS: CommandRailItem[] = [
  {
    id: "overview",
    label: "Overview",
    icon: undefined, // assigned in the component so icons stay a render concern
    panelId: PANEL_IDS.overview,
    shortcut: "⌘1",
  },
  {
    id: "evidence",
    label: "Evidence",
    panelId: PANEL_IDS.evidence,
    badge: 5,
    shortcut: "⌘2",
  },
  {
    id: "graph",
    label: "Graph",
    panelId: PANEL_IDS.graph,
    shortcut: "⌘3",
  },
  {
    id: "verify",
    label: "Verify",
    panelId: PANEL_IDS.verify,
    shortcut: "⌘4",
  },
  {
    id: "signals",
    label: "Signals",
    panelId: PANEL_IDS.signals,
    badge: 12,
    shortcut: "⌘5",
  },
  {
    id: "nodes",
    label: "Nodes",
    panelId: PANEL_IDS.nodes,
    shortcut: "⌘6",
  },
  {
    id: "sessions",
    label: "Sessions",
    panelId: PANEL_IDS.sessions,
    badge: 3,
    shortcut: "⌘7",
  },
  {
    id: "alerts",
    label: "Alerts",
    panelId: PANEL_IDS.alerts,
    badge: 2,
    shortcut: "⌘8",
  },
  {
    id: "settings",
    label: "Settings",
    panelId: PANEL_IDS.settings,
    shortcut: "⌘,",
  },
];

export type Stat = {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  direction?: "up" | "down";
};

export const OVERVIEW_STATS: Stat[] = [
  { label: "Active nodes", value: "48", delta: "+2", direction: "up" },
  { label: "Throughput", value: "12.4", unit: "k/s", delta: "+8.1%", direction: "up" },
  { label: "p95 latency", value: "184", unit: "ms", delta: "-12ms", direction: "up" },
  { label: "Error rate", value: "0.42", unit: "%", delta: "+0.08", direction: "down" },
];

export type Signal = {
  id: string;
  title: string;
  body: string;
  status: CompactCardStatus;
  time: string;
  source: string;
  target: string;
  highlight?: boolean;
};

export const SIGNALS: Signal[] = [
  {
    id: "sig-1",
    title: "Deploy succeeded on edge-eu-west-2",
    body: "Release 4.19.0 rolled to 12 nodes in 41s. No error budget consumed during the window.",
    status: "success",
    time: "14:02:11",
    source: "pipeline",
    target: "edge-eu-west-2",
    highlight: true,
  },
  {
    id: "sig-2",
    title: "Certificate expires in 9 days",
    body: "wildcard.celastyle.dev on lb-03. Renewal is scheduled but the last attempt returned a 403 from the ACME provider.",
    status: "warning",
    time: "13:58:40",
    source: "tls-monitor",
    target: "lb-03",
  },
  {
    id: "sig-3",
    title: "p95 crossed the 200ms budget",
    body: "Sustained for 6 consecutive minutes on the ingest path. Correlates with the 14:00 batch window.",
    status: "danger",
    time: "13:47:02",
    source: "slo-engine",
    target: "ingest",
    highlight: true,
  },
  {
    id: "sig-4",
    title: "Autoscaler added 2 replicas",
    body: "Triggered by sustained queue depth above 400 for 3 minutes. Cost impact is within the monthly envelope.",
    status: "info",
    time: "13:31:55",
    source: "autoscaler",
    target: "queue-worker",
  },
  {
    id: "sig-5",
    title: "Reconciled 1,204 drift events",
    body: "Terraform state re-applied across the fleet. Two resources required manual intervention and are listed in the audit log.",
    status: "neutral",
    time: "13:12:09",
    source: "reconciler",
    target: "fleet",
  },
  {
    id: "sig-6",
    title: "Cache hit ratio recovered to 94.2%",
    body: "Back within the 90% target after the previous eviction event cleared. No action required from the on-call rotation.",
    status: "success",
    time: "12:55:33",
    source: "metrics",
    target: "redis-01",
  },
];

export type Node = {
  id: string;
  region: string;
  status: CompactCardStatus;
  cpu: string;
  mem: string;
  uptime: string;
};

export const NODES: Node[] = [
  { id: "edge-eu-west-2-a", region: "eu-west-2", status: "success", cpu: "34%", mem: "61%", uptime: "41d 03h" },
  { id: "edge-eu-west-2-b", region: "eu-west-2", status: "success", cpu: "38%", mem: "58%", uptime: "41d 03h" },
  { id: "edge-us-east-1-a", region: "us-east-1", status: "warning", cpu: "78%", mem: "82%", uptime: "12d 19h" },
  { id: "edge-us-east-1-b", region: "us-east-1", status: "success", cpu: "29%", mem: "54%", uptime: "12d 19h" },
  { id: "edge-ap-south-1-a", region: "ap-south-1", status: "danger", cpu: "94%", mem: "91%", uptime: "2d 07h" },
  { id: "lb-03", region: "eu-west-2", status: "warning", cpu: "61%", mem: "47%", uptime: "96d 22h" },
  { id: "queue-worker-07", region: "us-east-1", status: "success", cpu: "44%", mem: "66%", uptime: "7d 11h" },
  { id: "redis-01", region: "eu-west-2", status: "success", cpu: "12%", mem: "72%", uptime: "203d 04h" },
];

export type Session = {
  id: string;
  title: string;
  status: CompactCardStatus;
  actor: string;
  started: string;
  duration: string;
};

export const SESSIONS: Session[] = [
  { id: "ses-9041", title: "Incident review — ingest degradation", status: "danger", actor: "n.al-hassan", started: "13:52", duration: "38m" },
  { id: "ses-9039", title: "Release 4.19.0 go/no-go", status: "success", actor: "m.okonkwo", started: "13:40", duration: "12m" },
  { id: "ses-9038", title: "Capacity planning Q4", status: "info", actor: "r.villalobos", started: "13:22", duration: "1h 05m" },
  { id: "ses-9034", title: "Certificate renewal runbook", status: "warning", actor: "s.devlin", started: "12:58", duration: "24m" },
  { id: "ses-9030", title: "On-call handover", status: "neutral", actor: "a.petrova", started: "12:30", duration: "06m" },
];

export type Alert = {
  id: string;
  title: string;
  body: string;
  status: CompactCardStatus;
  time: string;
  owner: string;
  severity: string;
};

export const ALERTS: Alert[] = [
  {
    id: "alr-118",
    title: "Edge latency budget exhausted",
    body: "p95 has been above the 200ms SLO for 18 minutes. Automatic rollback is armed but has not triggered.",
    status: "danger",
    time: "13:47",
    owner: "unassigned",
    severity: "P1",
  },
  {
    id: "alr-114",
    title: "Wildcard certificate expiring",
    body: "Renewal must complete before the 9-day mark or the load balancer will begin serving warnings to clients.",
    status: "warning",
    time: "12:05",
    owner: "s.devlin",
    severity: "P3",
  },
  {
    id: "alr-109",
    title: "Node ap-south-1-a memory pressure",
    body: "Sustained above 90% for 25 minutes. The node has not been evicted, but it is not accepting new work.",
    status: "warning",
    time: "11:44",
    owner: "m.okonkwo",
    severity: "P2",
  },
];
