import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { constants as FS } from "node:fs";
import { isAbsolute, relative, resolve, dirname, basename, join } from "node:path";
import { isInside, type SkillMeta } from "./execution-authority";
import type { ToolSurface } from "./capabilities";

/* =============================================================================
   Isolated Executor
   -----------------------------------------------------------------------------
   The arm. It runs a tool in a separate process so that a crash, an infinite
   loop or a runaway allocation kills the tool and nothing else — the pipeline,
   the ledger and the authority all live in the parent and must survive whatever
   the tool does.

   The parent holds no filesystem-write capability of its own. It decides
   (authority), supervises (here), and records (ledger). The child is the only
   thing that writes, which is what makes "isolated" mean something: a bug in
   the supervisor cannot corrupt a file, because the supervisor cannot.

   Three properties, each enforced rather than requested:

   1. Hard timeout. A hung child is SIGKILLed, not asked to stop. A child that
      ignores SIGTERM — the common case for a wedged loop — must not be able
      to hold the kernel open, and a graceful signal is a negotiation with a
      process that may be the thing that stopped negotiating.

   2. Output quota. stdout and stderr are counted as they arrive and the child
      is killed the moment either exceeds its cap. Buffering without a cap is
      a denial-of-service with extra steps: a tool that prints in a loop will
      exhaust memory before any timeout fires, because the timeout is measured
      in seconds and memory is measured in bytes.

   3. Real-path confinement. The authority already checked the path lexically,
      which cannot see a symlink. Here, with the filesystem in hand, the
      target is resolved through fs.realpath and the *real* result is what gets
      checked. That closes the escape the authority had to document as a
      limitation, and it is the last check before the write.

   The worker path is injectable so tests can supply a worker that misbehaves
   on demand — one that hangs, one that floods, one that dies. Production
   supplies the real one. No test hook exists in the production path.
   ========================================================================== */

export type ExecutorFailure = {
  kind:
    | "timeout"
    | "output_limit"
    | "crash"
    | "protocol"
    | "rejected"
    | "refused";
  reason: string;
};

export type ExecutionOutcome = {
  ok: boolean;
  /** The tool's own structured result, when it managed to produce one. */
  result?: unknown;
  /** Present when the tool refused on its own terms, e.g. a bad payload. */
  error?: string;
  /** How long the child actually ran. */
  ms: number;
  failure?: ExecutorFailure;
  /** Where the write landed, after symlink resolution. */
  path?: string;
  /** What the file held before, so an undo is possible. */
  previous?: string | null;
  existed?: boolean;
};

export type ExecutorOptions = {
  /** Path to the worker module. Defaults to the one shipped beside this file. */
  workerPath?: string;
  /** Node binary. Injectable so a test can point at a different one. */
  execPath?: string;
  /** Applied when the skill does not declare its own. */
  defaultTimeoutMs?: number;
  /** Per-stream cap. A tool that logs loudly dies rather than being believed. */
  maxOutputBytes?: number;
  /**
   * The task's capability set. When set, an action outside it is not run at
   * all — the call ends before a child process is spawned.
   *
   * This is where the capability boundary is actually load-bearing. The
   * policy engine refuses plans it dislikes, but a refusal is a decision
   * that can be mis-wired. Here the tool is simply not on offer: no argv is
   * built, no process starts, and there is nothing to bypass downstream
   * because nothing downstream was reached.
   *
   * The check is duplicated in the session host on purpose. A boundary
   * enforced in exactly one place is a boundary that one refactor can move.
   */
  surface?: ToolSurface;
  /**
   * Variables granted to this task, by name.
   *
   * There is no inheritance: a key that is not listed here is not in the
   * child, full stop. That is stricter than it looks — it means a worker
   * cannot read the server's environment at all, so anything it needs has to
   * be decided here and granted deliberately.
   */
  taskEnv?: Record<string, string>;
};

const DEFAULTS = {
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024,
};

/**
 * Find the worker script.
 *
 * Not a bare `new URL("./tools/worker.mjs", import.meta.url)`. That resolves
 * beside the *compiled* module, and nothing guarantees the worker is emitted
 * there: this file is bundled by Next into a chunk directory, and in the
 * test build it lands in a directory with no `tools/` at all. The path would
 * point at nothing, the child would fail to start, and the symptom would
 * arrive two layers away as a protocol error — or, worse, as a
 * verification failure on a step that never ran.
 *
 * The worker is a real file with a real path, so it is found by looking for
 * it rather than by assuming where a compiler put it. The first candidate
 * that exists wins; if none does, the beside-the-source guess is returned so
 * the failure names a path a person can go and look at.
 */
function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    /* Beside the source, which is right when running from source. */
    resolve(here, "tools/worker.mjs"),
    /* Beside the bundle, which is right when a build copied it along. */
    resolve(here, "../tools/worker.mjs"),
    resolve(here, "../../app/lib/tools/worker.mjs"),
    /* Walking up to the app root, which is where the source actually lives
       when this module is bundled or transpiled elsewhere. */
    resolve(here, "../../../apps/command-center/app/lib/tools/worker.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable: try the next one */
    }
  }
  return candidates[0]!;
}

/* ── child process supervision ─────────────────────────────────────────── */

/**
 * A constructed environment. Every value is a string because every value
 * was put here on purpose — `ProcessEnv` allows `undefined` precisely to
 * accommodate inheritance, which is the thing this type exists to rule out.
 */
export type ChildEnv = {
  /** Always set, and set to a real value rather than an arbitrary string.
     Next narrows this to a union, which is the right shape: it means the one
     variable every other key can shadow is the one variable whose value
     cannot drift into something a child would act on. */
  NODE_ENV: "development" | "production" | "test";
  [key: string]: string;
};

type ChildResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overLimit: boolean;
  ms: number;
};

/**
 * The only environment a worker is ever given.
 *
 * This was `env: { ...process.env }` and it is the single most important
 * line in the file.
 *
 * A capability surface says what a task may *do*. It says nothing about what
 * the process *holds*, and those are different attacks. A task granted
 * nothing but `workspace.write` was still receiving every variable in the
 * server's environment — so with an OAuth token in it, the surface was
 * decorative against exactly the threat it appeared to close. The child
 * could not have been asked to use the token. It simply already had it.
 *
 * So the environment is constructed, never inherited. A variable is in the
 * child only because something deliberately put it there.
 *
 * Two are the floor for running at all. PATH is there because a tool may
 * legitimately need to find a binary; it is a lookup path, not a secret.
 * NODE_ENV is a behaviour switch, not a credential. Everything else is an
 * explicit per-task grant, and the two L1 broker variables are named here
 * rather than being read from the parent.
 */
function childEnv(taskEnv: Record<string, string> = {}): ChildEnv {
  const env: ChildEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
  };

  for (const [key, value] of Object.entries(taskEnv)) {
    /* The grant is explicit, so the value is used verbatim. There is no
       fallback to the parent for a key that was not granted: reading one
       would reintroduce exactly the inheritance this removed, one key at a
       time and with a plausible-looking justification each time. */
    env[key] = value;
  }

  /* Secrets that belong to the broker rather than the worker are named, not
     pattern-matched. A deny-list of key shapes is the wrong instrument: it
     invents a vocabulary of what a secret looks like, misses every secret
     with an unusual name, and produces false confidence. An allow-list of
     names cannot miss a secret, because anything unnamed is absent. */
  for (const key of BROKER_SCOPED_KEYS) {
    if (env[key] === undefined) continue;
    /* Present, which means a caller injected it. That is allowed for now
       because the broker channel token is exactly this, but it is checked
       rather than assumed so the set stays a decision and not a habit. */
  }

  return env;
}

/** The only names allowed to hold a credential, and only a broker-scoped
 *  one. Empty until the broker exists; see docs/agent-os/credential-binding.md. */
const BROKER_SCOPED_KEYS = new Set<string>();

/**
 * Run the worker once and collect everything about it.
 *
 * The kill is SIGKILL and it is unconditional. There is no path here that
 * leaves a child running: on timeout, on output overflow, and on parent
 * teardown, the same escalation happens. A supervisor that sometimes lets a
 * process keep going is a supervisor that will eventually leak one.
 */
function runWorker(
  execPath: string,
  workerPath: string,
  request: unknown,
  timeoutMs: number,
  maxOutputBytes: number,
  taskEnv: Record<string, string> = {},
): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(execPath, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(taskEnv),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overLimit = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const absorb = (chunk: Buffer, into: "out" | "err") => {
      const next = (into === "out" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        if (!overLimit) {
          overLimit = true;
          // Killed the instant the cap is crossed, not after the process
          // finishes being helpful.
          kill();
        }
        return;
      }
      if (into === "out") stdout = next;
      else stderr = next;
    };

    child.stdout.on("data", (chunk: Buffer) => absorb(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => absorb(chunk, "err"));

    child.on("error", (error) => {
      stderr += String(error instanceof Error ? error.message : error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal, timedOut, overLimit, ms: Date.now() - started });
    });

    try {
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    } catch {
      // The child may have died before reading; "close" still fires and
      // reports it.
    }
  });
}

/* ── real-path confinement ─────────────────────────────────────────────── */

/**
 * Resolve the real path of a target and prove it is inside the allowed set.
 *
 * The target may not exist yet — creating a file is the common case — so the
 * nearest existing ancestor is resolved and the remainder appended. A symlink
 * anywhere along the existing portion is followed, which is the entire point:
 * `/allowed/link` pointing at `/etc` resolves to `/etc/...` and is refused.
 */
export async function resolveConfined(
  target: string,
  allowedDirectories: string[],
): Promise<{ ok: true; real: string } | { ok: false; reason: string }> {
  if (allowedDirectories.length === 0) {
    return { ok: false, reason: "no allowed directories were declared" };
  }

  // The allowed roots are themselves resolved, so a symlinked root does not
  // create an accidental second escape.
  const realRoots: string[] = [];
  for (const dir of allowedDirectories) {
    try {
      realRoots.push(await realpath(resolve(dir)));
    } catch {
      return { ok: false, reason: `allowed directory does not exist: ${dir}` };
    }
  }

  let probe = isAbsolute(target) ? target : resolve(allowedDirectories[0]!, target);
  const tail: string[] = [];
  for (;;) {
    try {
      await access(probe, FS.F_OK);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        return { ok: false, reason: `could not resolve any existing ancestor of ${target}` };
      }
      // basename, not a slice of the string: the slice drops the last
      // segment correctly only for paths this function produced, and a
      // silently wrong path is worse than an exception here.
      tail.unshift(basename(probe));
      probe = parent;
    }
  }

  const realBase = await realpath(probe);
  const real = join(realBase, ...tail);

  const contained = realRoots.some((root) => isInside(root, real));
  if (!contained) {
    return {
      ok: false,
      reason: `resolves to ${real}, which is outside every allowed directory`,
    };
  }

  return { ok: true, real };
}

/* ── the executor ──────────────────────────────────────────────────────── */

export class IsolatedExecutor {
  private readonly execPath: string;
  private readonly workerPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private surface?: ToolSurface;
  private taskEnv: Record<string, string>;

  /**
   * What each write overwrote, keyed by path, so a failed verification can be
   * undone. Unbounded by nature, so it is cleared when the pipeline confirms
   * a step — the pipeline calls commit() on success, and nothing here grows
   * forever in a long-lived agent.
   */
  private undo = new Map<string, { previous: string | null; existed: boolean }>();

  constructor(options: ExecutorOptions = {}) {
    this.execPath = options.execPath ?? process.execPath;
    this.workerPath = options.workerPath ?? defaultWorkerPath();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULTS.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
    this.surface = options.surface;
    this.taskEnv = options.taskEnv ?? {};
  }

  /**
   * Replace the task's granted variables.
   *
   * Whole-value replacement, never a merge. A merge would keep every key
   * already granted, which is how a variable granted for one capability
   * quietly outlives it and becomes ambient authority again.
   */
  setTaskEnv(env: Record<string, string>): void {
    this.taskEnv = { ...env };
  }

  /** What the child would be given. Exposed so a leak is checkable without
   *  spawning a process to find out. */
  describeEnv(): ChildEnv {
    return childEnv(this.taskEnv);
  }

  /**
   * Replace the capability set.
   *
   * Used when a task is granted a capability mid-run. The replacement is
   * whole rather than additive because a surface is a value: handing the
   * executor the exact set currently in force means there is no interval
   * during which it holds a wider one than the task has.
   */
  setSurface(surface: ToolSurface | undefined): void {
    this.surface = surface;
  }

  /** How many undo records are being held. Exposed so a leak is observable. */
  get pendingUndos(): number {
    return this.undo.size;
  }

  private timeoutFor(skill: SkillMeta | undefined): number {
    const declared = skill?.timeout_ms;
    return typeof declared === "number" && declared > 0 ? declared : this.defaultTimeoutMs;
  }

  async run(
    action: string,
    payload: unknown,
    skill?: SkillMeta,
  ): Promise<ExecutionOutcome> {
    const result = await this.dispatch(action, payload, skill);
    if (result.ok && action === "write_file" && typeof result.path === "string") {
      this.undo.set(result.path, {
        previous: result.previous ?? null,
        existed: result.existed ?? false,
      });
    }
    return result;
  }

  private async dispatch(
    action: string,
    payload: unknown,
    skill?: SkillMeta,
  ): Promise<ExecutionOutcome> {
    /* The capability boundary, before anything else. Deliberately ahead of
       the path check: a tool that was never granted has no business having
       its payload examined, and the refusal it gets should name the
       capability rather than a path the agent was never entitled to use. */
    if (this.surface && !this.surface.has(action)) {
      const reason =
        this.surface.denyReasonFor(action) ?? `"${action}" is not in this task's capability set`;
      return {
        ok: false,
        ms: 0,
        failure: { kind: "refused", reason },
      };
    }

    const allowedDirectories = skill?.allowed_directories ?? [];
    const isWrite = action === "write_file";
    const isRead = action === "read_file";

    // Confinement is decided here, at the last moment before the write, and
    // against the real filesystem. The authority's lexical check is not
    // repeated — it would pass — but its limitation is closed.
    if (isWrite || isRead) {
      const path = (payload as { path?: unknown })?.path;
      if (typeof path !== "string") {
        return {
          ok: false,
          ms: 0,
          error: `${action} needs a string path`,
          failure: { kind: "rejected", reason: "payload has no string path" },
        };
      }
      const confined = await resolveConfined(path, allowedDirectories);
      if (confined.ok === false) {
        return {
          ok: false,
          ms: 0,
          error: confined.reason,
          failure: { kind: "refused", reason: confined.reason },
        };
      }
    }

    const child = await runWorker(
      this.execPath,
      this.workerPath,
      { action, payload },
      this.timeoutFor(skill),
      this.maxOutputBytes,
      this.taskEnv,
    );

    if (child.timedOut) {
      return {
        ok: false,
        ms: child.ms,
        failure: {
          kind: "timeout",
          reason: `exceeded its ${this.timeoutFor(skill)}ms budget and was killed`,
        },
      };
    }

    if (child.overLimit) {
      return {
        ok: false,
        ms: child.ms,
        failure: {
          kind: "output_limit",
          reason: `produced more than ${this.maxOutputBytes} bytes and was killed`,
        },
      };
    }

    /* A child killed by a signal never got to report. An exit code of 0 with
       no output is just as untrustworthy: it means something wrote nothing,
       which is indistinguishable from a tool that never ran. */
    if (child.signal !== null || child.code !== 0 || child.stdout.trim() === "") {
      return {
        ok: false,
        ms: child.ms,
        error: child.stderr.trim().slice(0, 500) || undefined,
        failure: {
          kind: child.signal ? "crash" : "protocol",
          reason: child.signal
            ? `terminated by ${child.signal}`
            : child.code !== 0
              ? `exited with code ${child.code}`
              : "produced no result",
        },
      };
    }

    /* A tool may log to stdout before answering — progress bars, warnings,
       a line of context. The result is the last line, and taking the whole
       buffer would mean a chatty-but-correct tool is treated as a protocol
       failure. Taking the last *parseable* line would be too forgiving: a
       truncated write would then be read as an answer, which is the exact
       confusion this layer exists to prevent. Last line, parsed strictly. */
    const lines = child.stdout.trim().split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines.at(-1) ?? "";

    let parsed: { ok?: boolean; error?: string; path?: string; previous?: string | null; existed?: boolean };
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      return {
        ok: false,
        ms: child.ms,
        error: child.stdout.trim().slice(0, 500) || undefined,
        failure: {
          kind: "protocol",
          reason: "the last line of output was not a result the supervisor can read",
        },
      };
    }

    if (parsed.ok !== true) {
      return {
        ok: false,
        ms: child.ms,
        error: parsed.error ?? "the tool refused the request",
        failure: { kind: "rejected", reason: parsed.error ?? "tool reported failure" },
      };
    }

    return {
      ok: true,
      ms: child.ms,
      result: parsed,
      path: parsed.path,
      previous: parsed.previous ?? null,
      existed: parsed.existed ?? false,
    };
  }

  /**
   * Undo a write. Runs in a child too, for the same reasons as everything
   * else — an undo that can crash must not take the kernel with it.
   */
  async rollback(step: { payload?: unknown; skill?: SkillMeta }): Promise<void> {
    const path = (step.payload as { path?: unknown })?.path;
    if (typeof path !== "string") throw new Error("nothing to roll back: no path");

    const record = this.undo.get(path);
    if (!record) throw new Error(`no undo is recorded for ${path}`);

    const child = await runWorker(
      this.execPath,
      this.workerPath,
      {
        action: "__restore",
        payload: { path, previous: record.previous, existed: record.existed },
      },
      this.timeoutFor(step.skill),
      this.maxOutputBytes,
      this.taskEnv,
    );

    if (child.timedOut || child.overLimit || child.signal !== null || child.code !== 0) {
      throw new Error(`rollback did not complete: ${child.stderr.trim().slice(0, 200) || "child failed"}`);
    }

    this.undo.delete(path);
  }

  /** Called by the pipeline once a step is verified, so undo records do not
   *  accumulate for work that was never questioned. */
  commit(step: { payload?: unknown }): void {
    const path = (step.payload as { path?: unknown })?.path;
    if (typeof path === "string") this.undo.delete(path);
  }
}
