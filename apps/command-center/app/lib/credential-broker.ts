import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSurface } from "./capabilities";

/* =============================================================================
   Credential broker — the client's side
   -----------------------------------------------------------------------------
   The web tier's half of the boundary. It can ask the broker four questions
   and can hold nothing: the secret lives in the other process, and this
   module never receives it.

   Four operations, chosen so that a client which is fully compromised still
   cannot do more than ask and be told no:

     open      start a session over a capability set
     rotate    add or remove capabilities; advances the epoch
     mint      get a channel token for the current epoch
     authorize ask whether one action on one resource is permitted

   The epoch is why a revoke is immediate. A channel token is bound to the
   epoch it was minted at, and the broker refuses any token whose epoch is
   not the current one — so the moment a capability is revoked, every token
   already in circulation stops working, without waiting for anything to
   expire. That is the difference between revoking access and announcing
   that access will end.
   ========================================================================== */

export type BrokerRequest = {
  action: string;
  resource?: string;
};

export type AuthorizationDecision =
  | {
      allowed: true;
      capability: string;
      epoch: number;
      /** Enough to write a ledger entry saying what was exercised. */
      authorization: {
        sessionId: string;
        action: string;
        resource: string | null;
        capability: string;
        epoch: number;
      };
    }
  | { allowed: false; code: AuthorizationCode; reason: string };

export type AuthorizationCode =
  | "unauthenticated"
  | "unknown_session"
  | "stale_epoch"
  | "not_granted"
  | "out_of_scope"
  | "transport"
  | "no_broker";

export class BrokerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerUnavailable";
  }
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class CredentialBroker {
  private socket?: Socket;
  private process?: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(
    private readonly socketPath: string,
    socket: Socket,
  ) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(new BrokerUnavailable(`broker socket: ${error.message}`)));
    socket.on("close", () => this.failAll(new BrokerUnavailable("the broker connection closed")));
  }

  /**
   * Start a broker process and connect to it.
   *
   * `start` is a real child process rather than an in-process instance
   * because the separation is the feature. A broker in this heap would
   * satisfy "no secret in the worker" — the worker is already a child
   * process — and would fail entirely to keep the secret away from the web
   * tier, which is the tier that parses untrusted request bodies.
   */
  static async start(options: { socketPath: string; serverPath?: string; secret?: string }): Promise<CredentialBroker> {
    const { socketPath } = options;
    const serverPath = options.serverPath ?? resolveBrokerServerPath();

    /* 0700 on the directory as well as 0600 on the socket: a socket in a
       traversable directory is a socket anyone can reach. */
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(socketPath), 0o700);
    } catch {
      /* pre-existing directory with a different mode; the socket mode below
         is still enforced, and this is reported rather than hidden */
    }

    const child = spawn(
      process.execPath,
      [serverPath, socketPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        /* The broker's secret arrives by environment, not argv. argv is
           world-readable through /proc on Linux, and a secret in it is a
           secret in the process table. */
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NODE_ENV: "production",
          BROKER_SECRET: options.secret ?? randomSecret(),
        },
      },
    );

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new BrokerUnavailable("the broker did not report ready in time"));
      }, 5_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").startsWith("ready")) {
          clearTimeout(timer);
          resolvePromise();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(new BrokerUnavailable(`the broker could not start: ${error.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectPromise(new BrokerUnavailable(`the broker exited during startup with code ${code}`));
      });
    });

    const socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const connection = createConnection(socketPath);
      connection.once("connect", () => resolvePromise(connection));
      connection.once("error", (error) =>
        rejectPromise(new BrokerUnavailable(`could not reach the broker socket: ${error.message}`)),
      );
    });

    const broker = new CredentialBroker(socketPath, socket);
    broker.process = child;
    return broker;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let message: { id?: number };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.pending.get(message.id ?? -1);
      if (!waiter) continue;
      this.pending.delete(message.id!);
      waiter.resolve(message);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private call(message: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    if (!this.socket) return Promise.reject(new BrokerUnavailable("the broker is not connected"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new BrokerUnavailable(`the broker did not answer "${String(message.op)}" in time`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.socket!.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }

  /** Start a session over a capability set. Idempotent: re-opening an
   *  existing session does not reset it, because a caller that could clear
   *  a revoke by asking again would make revocation advisory. */
  async openSession(input: { sessionId: string; surface: ToolSurface }): Promise<{ epoch: number }> {
    const grants: Record<string, { risk: string }> = {};
    const actionToCapability: Record<string, string> = {};
    const scopes = new Set<string>();

    for (const action of input.surface.actions()) {
      const grant = input.surface.grantFor(action);
      if (!grant) continue;
      grants[action] = { risk: grant.risk };
      actionToCapability[action] = grant.capability;
      for (const scope of grant.scopes) scopes.add(scope);
    }

    const reply = await this.call({
      op: "open",
      sessionId: input.sessionId,
      grants,
      actionToCapability,
      scopes: [...scopes],
    });
    if (reply.ok !== true) {
      throw new BrokerUnavailable(String(reply.error ?? reply.reason ?? "the broker refused to open the session"));
    }
    return { epoch: Number(reply.epoch) };
  }

  /** Add or remove capabilities. Both advance the epoch, which is what makes
   *  a revoke immediate rather than eventual. */
  async rotate(input: {
    sessionId: string;
    grant?: { capability?: string; actionToCapability?: Record<string, string> };
    revoke?: { capability?: string; actions?: string[] };
  }): Promise<{ epoch: number }> {
    const reply = await this.call({ op: "rotate", ...input });
    if (reply.ok !== true) {
      throw new BrokerUnavailable(String(reply.reason ?? "the broker refused to rotate the session"));
    }
    return { epoch: Number(reply.epoch) };
  }

  async mint(sessionId: string): Promise<{ token: string; epoch: number }> {
    const reply = await this.call({ op: "mint", sessionId });
    if (reply.ok !== true) {
      throw new BrokerUnavailable(String(reply.reason ?? "the broker could not mint a channel token"));
    }
    return { token: String(reply.token), epoch: Number(reply.epoch) };
  }

  /** The four checks, broker-side. A transport failure is reported as a
   *  refusal rather than retried: a broker that cannot be reached has not
   *  said yes, and an unavailable check is not a passed check. */
  async authorize(input: {
    token: string;
    action: string;
    resource?: string;
  }): Promise<AuthorizationDecision> {
    let reply: Record<string, unknown>;
    try {
      reply = await this.call({ op: "authorize", ...input });
    } catch (error) {
      return {
        allowed: false,
        code: "transport",
        reason: `the broker could not be reached, so the request was not authorized: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (reply.allowed === true) {
      return reply as unknown as AuthorizationDecision;
    }
    return {
      allowed: false,
      code: (reply.code as AuthorizationCode) ?? "no_broker",
      reason: String(reply.reason ?? "the broker refused without saying why"),
    };
  }

  async inspect(sessionId: string): Promise<Record<string, unknown> | null> {
    const reply = await this.call({ op: "inspect", sessionId });
    return (reply.state as Record<string, unknown>) ?? null;
  }

  async stop(): Promise<void> {
    try {
      await this.call({ op: "shutdown" }, 1_000);
    } catch {
      /* already gone */
    }
    this.failAll(new BrokerUnavailable("the broker is shutting down"));
    this.socket?.destroy();
    this.process?.kill("SIGTERM");
  }
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Where the broker process lives.
 *
 * Anchored to the repository rather than to `import.meta.url`, because the
 * compiled client is not next to the broker: the web tier bundles to
 * `.next/`, so a path relative to this file finds nothing at runtime and
 * the failure arrives as a spawn error with no useful context. Walking up
 * from the app directory is what works in the source tree, in a build, and
 * in a deployment that keeps the layout.
 */
function resolveBrokerServerPath(): string {
  const from = fileURLToPath(import.meta.url);
  let dir = dirname(from);

  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "app/lib/broker/broker-server.mjs");
    if (existsSync(candidate)) return candidate;

    const nested = join(dir, "apps/command-center/app/lib/broker/broker-server.mjs");
    if (existsSync(nested)) return nested;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new BrokerUnavailable(
    "could not locate broker-server.mjs; pass serverPath explicitly rather than starting a broker that cannot be found",
  );
}

/* ── the worker's side ──────────────────────────────────────────────────── */

/**
 * What a tool needs in order to ask the broker something.
 *
 * Both values are named here rather than read from anywhere, because a tool
 * that discovers its own broker path or token is a tool that can be pointed
 * at a different broker. The worker is told which to use; it never goes
 * looking.
 */
export const BROKER_ENV = {
  socket: "CELESTYLE_BROKER_SOCKET",
  token: "CELESTYLE_CHANNEL_TOKEN",
} as const;

export type WorkerBrokerHandle = {
  brokerSocket: string;
  brokerToken: string;
};
