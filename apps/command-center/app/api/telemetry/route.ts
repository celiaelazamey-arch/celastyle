import { deriveTone, type EvidenceMetrics } from "@celastyle/ui";

/* =============================================================================
   Telemetry stream
   -----------------------------------------------------------------------------
   Server-Sent Events rather than WebSocket. Three reasons, all structural:

   1. The data flows one way. Telemetry is server → client; SSE is built for
      exactly that. A WebSocket would buy bidirectional capability this feature
      never uses.
   2. `EventSource` reconnects on its own, with backoff, for free. A WebSocket
      needs a reconnect loop written by hand, plus a liveness ping and a
      re-subscribe path — and that code is wrong the first time it is written.
   3. SSE is plain HTTP. It runs inside a Next.js route handler with no custom
      server, so `next dev` and `next start` keep working unchanged. A
      WebSocket cannot share a port with the app without taking over the server.

   The stream is a simulation: it walks a pipeline gate by gate, so the client
   sees the same sequence a real CI run would produce.
   ========================================================================== */

export type GateId = "scope" | "tests" | "type" | "build" | "security" | "compat";

export type TelemetryEvent =
  | { type: "run:start"; runId: string; intent: string; scope: string; at: number }
  | { type: "gate"; runId: string; gate: GateId; outcome: "pass" | "fail" | "run"; value?: string; detail?: string; at: number }
  | { type: "deploy"; runId: string; environment: string; outcome: "pass" | "fail"; at: number }
  | { type: "run:end"; runId: string; verdict: string; metrics: EvidenceMetrics; at: number };

const INTENTS = [
  { intent: "widen the git refspec to all branches", scope: "packages/tokens" },
  { intent: "pin postcss to clear the advisory", scope: "root · deps" },
  { intent: "aria combobox for the command palette", scope: "packages/ui" },
  { intent: "derive verdict tone from the metrics", scope: "packages/ui" },
  { intent: "portal the policy slide-over", scope: "apps/command-center" },
  { intent: "token aliases for the surface layer", scope: "packages/tokens" },
] as const;

const GATE_ORDER: GateId[] = ["scope", "tests", "type", "build", "security", "compat"];

/** Roughly one gate per 1.4s, a new run every ~5 gates. Fast enough to read
 *  as live, slow enough that individual transitions are legible. */
const GATE_DELAY_MS = 1400;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  let runIndex = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: TelemetryEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // The consumer went away between the cancel check and the enqueue.
          cancelled = true;
        }
      };

      const nextRun = () => {
        if (cancelled) return;
        const spec = INTENTS[runIndex % INTENTS.length]!;
        runIndex += 1;
        const runId = String(9000 + runIndex);
        const now = Date.now();

        send({
          type: "run:start",
          runId,
          intent: spec.intent,
          scope: spec.scope,
          at: now,
        });

        // One run in four fails, so the stream exercises the failure path
        // rather than only ever showing green.
        const willFail = runIndex % 4 === 0;
        const failGate = GATE_ORDER[2]!;

        const totalTests = 18 + ((runIndex * 7) % 22);
        const failedTests = willFail ? 1 + (runIndex % 3) : 0;
        const vulnerabilities = willFail ? 1 : 0;
        const breaking = !willFail && runIndex % 3 === 0;

        let step = 0;
        const advance = () => {
          if (cancelled) return;

          if (step >= GATE_ORDER.length) {
            const metrics: EvidenceMetrics = {
              unitTests: { total: totalTests, passed: totalTests - failedTests, failed: failedTests },
              typeCheck: "PASS",
              buildStatus: willFail ? "FAIL" : "PASS",
              securityScan: {
                status: willFail ? "FAIL" : "PASS",
                vulnerabilitiesFound: vulnerabilities,
                secretsExposed: false,
              },
              apiBackwardsCompatible: !breaking,
            };

            const tone = deriveTone(metrics);
            send({
              type: "run:end",
              runId,
              verdict:
                tone === "success" ? "VERIFIED" : tone === "danger" ? "REJECTED" : "IN_REVIEW",
              metrics,
              at: Date.now(),
            });

            if (tone === "success") {
              send({
                type: "deploy",
                runId,
                environment: "production",
                outcome: "pass",
                at: Date.now(),
              });
            }

            timer = setTimeout(advance, 900);
            return;
          }

          const gate = GATE_ORDER[step]!;
          step += 1;

          const isFailGate = willFail && gate === failGate;
          const outcome: "pass" | "fail" = isFailGate ? "fail" : "pass";

          // Announce the gate as running one tick before it resolves, so the
          // client renders the "running" state rather than jumping straight
          // from idle to result.
          send({
            type: "gate",
            runId,
            gate,
            outcome: "run",
            at: Date.now(),
          });

          timer = setTimeout(() => {
            send({
              type: "gate",
              runId,
              gate,
              outcome,
              value:
                gate === "tests"
                  ? `${totalTests - failedTests}/${totalTests}`
                  : gate === "build"
                    ? `${(1.1 + (runIndex % 5) * 0.3).toFixed(1)}s`
                    : undefined,
              detail: isFailGate
                ? gate === "build"
                  ? "build failed"
                  : "2 tests failing"
                : breaking && gate === "compat"
                  ? "breaking change"
                  : undefined,
              at: Date.now(),
            });
            timer = setTimeout(advance, GATE_DELAY_MS);
          }, 500);
        };

        advance();
      };

      nextRun();

      // Close cleanly if the browser navigates away or the tab is suspended.
      request.signal.addEventListener("abort", () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },

    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some CDNs buffer SSE by default, which delays every event
      // until the buffer fills. These headers turn buffering off.
      "X-Accel-Buffering": "no",
    },
  });
}
