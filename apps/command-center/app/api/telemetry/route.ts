import { verify } from "../../lib/verify";

/* =============================================================================
   Telemetry — real verification over SSE
   -----------------------------------------------------------------------------
   Streams this repository's actual gate results. Nothing is simulated: the
   verdicts, the test counts, the build time and the vulnerability total are
   what the commands actually produced.

   SSE rather than WebSocket, for three structural reasons:

   1. The data flows one way. Telemetry is server → client; SSE is built for
      exactly that. A WebSocket would buy bidirectional capability this feature
      never uses.
   2. `EventSource` reconnects on its own, with backoff, for free. A WebSocket
      needs a reconnect loop written by hand, plus a liveness ping and a
      re-subscribe path — and that code is wrong the first time it is written.
   3. SSE is plain HTTP. It runs inside a Next.js route handler with no custom
      server, so `next dev` and `next start` keep working unchanged.

   Progress is real. Each gate is announced as running when the server starts
   it and delivered with its result the moment that command exits — so the test
   results arrive while the build is still compiling, instead of the whole
   verdict appearing at the end. Nothing here sleeps to pace the animation: a
   delay that is not measuring a command is a lie about how long the work took.

   One run, one connection. The stream ends when the run does. A client that
   wants a fresh run re-requests, and the server's cache makes that cheap.
   ========================================================================== */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* How often to emit a comment line while a long gate is still running. The
   build can take half a minute, and a proxy in front of the app will close a
   connection that has been silent that long. A comment is invisible to
   `EventSource` but keeps the socket warm. */
const HEARTBEAT_MS = 15_000;

function encode(type: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

function comment(text: string): Uint8Array {
  return new TextEncoder().encode(`: ${text}\n\n`);
}

export async function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;

      const send = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          /* consumer disconnected */
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // If the client walks away mid-build, stop paying for the work nobody
      // is listening to. The run itself is still cached, so a reconnecting
      // client gets the result rather than triggering a second run.
      const onAbort = () => {
        close();
        request.signal.removeEventListener?.("abort", onAbort);
      };
      request.signal.addEventListener?.("abort", onAbort);

      heartbeat = setInterval(() => send(comment("running")), HEARTBEAT_MS);

      send(encode("run:start", { type: "run:start", at: Date.now() }));

      try {
        const result = await verify({
          /* Emitted the moment a command exits — the test result reaches the
             client while the build is still running. */
          onGateState: (id, state) =>
            send(
              encode("gate", {
                type: "gate",
                gate: id,
                outcome: state,
                at: Date.now(),
              }),
            ),
          onGate: (gate) =>
            send(
              encode("gate", {
                type: "gate",
                gate: gate.id,
                outcome: gate.outcome,
                value: gate.value,
                detail: gate.detail,
                ms: gate.ms,
                environmental: gate.environmental,
                at: Date.now(),
              }),
            ),
        });

        send(
          encode("run:end", {
            type: "run:end",
            runId: result.runId,
            intent: result.intent,
            scope: result.scope,
            verdict: result.verdict,
            summary: result.summary,
            finishedAt: result.finishedAt,
            at: Date.now(),
          }),
        );

        /* Deploy is derived from the verdict, not simulated. It is emitted
           only when every gate actually passed. */
        if (result.verdict === "VERIFIED") {
          send(
            encode("deploy", {
              type: "deploy",
              runId: result.runId,
              environment: "ci",
              outcome: "pass",
              at: Date.now(),
            }),
          );
        }
      } catch (error) {
        send(
          encode("error", {
            type: "error",
            message: error instanceof Error ? error.message : "verification failed",
            at: Date.now(),
          }),
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
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
