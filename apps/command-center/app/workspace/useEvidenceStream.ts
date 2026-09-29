"use client";

import { useEffect, useRef, useState } from "react";
import type { TelemetryWireEvent } from "../lib/verify";

/* =============================================================================
   useEvidenceStream
   -----------------------------------------------------------------------------
   Subscribes to the SSE feed and folds it into graph state.

   Three details that are easy to get wrong:

   1. Events arrive between React renders, and several can land in one tick.
      Each is written into a ref immediately and a render is scheduled, so a
      burst of gate results produces one render rather than six.
   2. The connection status is state, not a ref. The UI needs to show it, and a
      ref would not trigger the render that displays it.
   3. EventSource dispatches named events (event: gate) *in addition to*
      onmessage. A server that sets `event:` will therefore have those events
      delivered to onmessage only if it does NOT set a custom event name — so
      this listener is attached per event name, and onmessage is used solely
      as a fallback. Getting this wrong silently drops every event.
   ========================================================================== */

export type GateState = {
  /* "running" is a live in-flight state the server announces when it starts a
     command; "run" is the optimistic state a gate holds before the server says
     anything, so the graph renders a full skeleton immediately. */
  outcome: "pass" | "fail" | "run" | "running" | "resolved" | "skip";
  value?: string;
  detail?: string;
  ms?: number;
  /** The command failed because of the environment, not the change. */
  environmental?: boolean;
};

export type LiveRun = {
  runId: string;
  intent: string;
  scope: string;
  /** Every gate starts running so the graph renders a full skeleton
   *  immediately, rather than growing a column at a time. */
  gates: Record<string, GateState>;
  verdict?: string;
  /** null means "not measured", which is not the same as zero. */
  summary?: {
    testsTotal: number | null;
    testsPassed: number | null;
    testsFailed: number | null;
    vulnerabilities: number | null;
    typeErrors: number | null;
    buildSeconds: number | null;
  };
  deploy?: { environment: string; outcome: "pass" | "fail" };
  /** Set when the stream reports an error rather than a verdict. */
  error?: string;
  at: number;
};

export type StreamStatus = "connecting" | "live" | "complete" | "done" | "error";

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
  const sourceRef = useRef<EventSource | null>(null);

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

    const handle = (raw: MessageEvent) => {
      let event: TelemetryWireEvent;
      try {
        event = JSON.parse(raw.data) as TelemetryWireEvent;
      } catch {
        return;
      }

      schedule(() => {
        switch (event.type) {
          case "run:start": {
            runRef.current = {
              runId: "",
              intent: "",
              scope: "",
              gates: emptyGates(),
              at: event.at,
            };
            break;
          }
          case "gate": {
            const current = runRef.current;
            if (!current) return;
            current.gates = {
              ...current.gates,
              [event.gate]: {
                outcome: event.outcome,
                value: event.value,
                detail: event.detail,
                ms: event.ms,
                environmental: event.environmental,
              },
            };
            break;
          }
          case "run:end": {
            const current = runRef.current;
            if (!current) return;
            current.runId = event.runId;
            current.intent = event.intent;
            current.scope = event.scope;
            current.verdict = event.verdict;
            current.summary = event.summary;

            /* One run, one connection. `EventSource` reconnects whenever a
               server closes the stream normally — so a completed run would
               otherwise immediately start a second one, and a second build,
               forever. Closing on `run:end` is what makes "the run is over"
               mean the run is over.

               A genuine *error* (the socket dying mid-run) is the opposite
               case: that is exactly when the built-in reconnect is wanted, so
               the source is left open there. */
            sourceRef.current?.close();
            setStatus("done");
            break;
          }
          case "deploy": {
            const current = runRef.current;
            if (!current) return;
            current.deploy = { environment: event.environment, outcome: event.outcome };
            break;
          }
          case "error": {
            const current = runRef.current;
            if (current) current.error = event.message;
            setStatus("error");
            break;
          }
        }
      });
    };

    source.onopen = () => setStatus("live");
    source.onmessage = handle;
    // Named events bypass onmessage, so each is bound explicitly.
    for (const name of ["run:start", "gate", "run:end", "deploy", "error"]) {
      source.addEventListener(name, handle as EventListener);
    }

    source.onerror = () => {
      /* EventSource reconnects on its own after an unexpected drop, which is
         the behaviour we want: the server cache means the reconnected run is
         near-instant. But if it has already been closed deliberately (on
         `run:end`, or on unmount) there is nothing to report. */
      if (sourceRef.current?.readyState === EventSource.CLOSED) {
        setStatus((s) => (s === "error" ? "error" : "complete"));
      }
    };

    sourceRef.current = source;

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      sourceRef.current = null;
      source.close();
    };
  }, [url]);

  return { run, status };
}
