import { createServer } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { createBroker } from "./broker-core.mjs";

/* =============================================================================
   Broker server — the standalone process
   -----------------------------------------------------------------------------
   Runs as its own program, not as a library inside the web tier. The
   separation is the point: this process is the only one that holds a
   credential, and the web tier — which parses untrusted HTTP bodies — is a
   different process with a different attack surface.

   It speaks newline-delimited JSON over a unix domain socket, and it holds
   no state on disk. Restarting it voids every session, which is the correct
   failure mode for a credential broker and worth stating rather than
   hiding: a broker that quietly reloaded its state from a file would be a
   broker with a secret at rest.

   The socket is created 0600 inside a 0700 directory. A broker socket in a
   world-readable temp directory is a broker anyone local can talk to, which
   would undo the isolation this process exists to provide.
   ========================================================================== */

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: broker-server.mjs <socket-path>\n");
  process.exit(2);
}

const broker = createBroker({ secret: process.env.BROKER_SECRET });

/* Clear a stale socket from a previous run. A path left behind by a dead
   process would otherwise make bind fail with an error that looks like a
   permissions problem. */
try {
  unlinkSync(socketPath);
} catch {
  /* nothing there, which is the normal case */
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    /* Newline-delimited, because a broker's messages are small and a
       length-prefixed framing bug is a bug that hangs rather than one that
       throws. Each line is a complete request. */
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;

      let response;
      try {
        const message = JSON.parse(line);
        response = handle(message);
      } catch (error) {
        response = { id: null, ok: false, error: error instanceof Error ? error.message : "bad request" };
      }
      socket.write(`${JSON.stringify(response)}\n`);
    }
  });

  socket.on("error", () => {
    /* A client that disconnects mid-request is ordinary, not a failure
       worth logging a stack for. */
  });
});

/* Every message is a method call and nothing else. There is no generic
   "run this" and no way to reach the broker's internals: a client can ask
   the four questions and get the four answers, and that is the whole API
   surface a compromised worker could have. */
function handle(message) {
  const { id, op } = message ?? {};
  const reply = (payload) => ({ id, ...payload });

  switch (op) {
    case "open":
      return reply(broker.openSession(message));
    case "rotate":
      return reply(broker.rotate(message.sessionId, message));
    case "mint":
      return reply(broker.mint(message.sessionId));
    case "authorize":
      return reply(broker.authorize(message));
    case "inspect":
      return reply({ ok: true, state: broker.inspect(message.sessionId) });
    case "shutdown":
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
      process.exit(0);
    // eslint-disable-next-line no-fallthrough
    default:
      return reply({ ok: false, error: `unknown operation ${JSON.stringify(op)}` });
  }
}

server.listen(socketPath, () => {
  /* Restrict before announcing readiness. A client that connects in the
     window between listen() and chmod() would get a world-writable socket,
     and that window is exactly the kind of thing that is never observed
     until it has been exploited. */
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    process.stderr.write("could not restrict the broker socket\n");
    process.exit(1);
  }
  process.stdout.write(`ready ${socketPath}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`broker failed: ${error.message}\n`);
  process.exit(1);
});
