"use client";

import { useEffect, useRef, useState } from "react";
import type { TelemetryEvent } from "../api/telemetry/route";

/* =============================================================================
   useEvidenceStream
   -----------------------------------------------------------------------------
   Subscribes to the SSE feed and folds it into graph state.

   Two details that are easy to get wrong:

   1. Events arrive between React renders, and several can land in one tick.
      Each one is written into a ref immediately and a render is scheduled, so
      a burst of gate results produces one render rather than six.
   2. The connection status is state, not a ref. The UI needs to show it, and
      a ref would not trigger the render that displays it.
   ========================================================================== */

export type GateState = {
  outcome: "pass" | "fail" | "run";
  value?: string;
  detail?: string;
};

export type LiveRun = {
  runId: string;
  intent: string;
  scope: string;
  /** Every gate starts idle so the graph renders a full skeleton immediately,
   *  rather than growing a column at a time. */
  gates: Record<string, GateState>;
  verdict?: string;
  deploy?: { environment: string; outcome: "pass" | "fail" };
  at: number;
};

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

const GATE_IDS = ["scope", "tests", "type", "build", "security", "compat"] as const;

function emptyGates(): Record<string, GateState> {
  return Object.fromEntries(
    GATE_IDS.map((id) => [id, { outcome: "run" as const }]),
  );
}

export function useEvidenceStream(url = "/api/telemetry") {
  const [run, setRun] = useState<LiveRun | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  const runRef = useRef<LiveRun | null>(null);
  const frameRef = useRef<number | null>(null);

  /** Coalesce a burst of events into a single render. */
  const schedule = (mutate: () => void) => {
    mutate();
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setRun(runRef.current);
    });
  };

  useEffect(() => {
    const source = new EventSource(url);

    source.onopen = () => setStatus("live");

    source.onmessage = (message) => {
      let event: TelemetryEvent;
      try {
        event = JSON.parse(message.data) as TelemetryEvent;
      } catch {
        return;
      }

      schedule(() => {
        if (event.type === "run:start") {
          runRef.current = {
            runId: event.runId,
            intent: event.intent,
            scope: event.scope,
            gates: emptyGates(),
            at: event.at,
          };
          return;
        }

        const current = runRef.current;
        if (!current || current.runId !== event.runId) return;

        if (event.type === "gate") {
          runRef.current = {
            ...current,
            gates: {
              ...current.gates,
              [event.gate]: {
                outcome: event.outcome,
                value: event.value,
                detail: event.detail,
              },
            },
          };
        } else if (event.type === "run:end") {
          runRef.current = { ...current, verdict: event.verdict };
        } else if (event.type === "deploy") {
          runRef.current = {
            ...current,
            deploy: { environment: event.environment, outcome: event.outcome },
          };
        }
      });
    };

    // EventSource reconnects on its own; this only reflects the state so the
    // UI can say so rather than looking frozen.
    source.onerror = () => {
      setStatus(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      source.close();
    };
  }, [url]);

  return { run, status };
}
