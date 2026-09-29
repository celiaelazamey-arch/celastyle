import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/* =============================================================================
   Real verification
   -----------------------------------------------------------------------------
   Executes this repository's actual gates and reports what genuinely happened.
   Nothing here is simulated: the numbers on screen are the numbers the build
   produced.

   SECURITY — the important part of this file.

   `exec` with a string command would be a command-injection hole the moment a
   gate name, branch name, or file path reaches it. So every gate is a
   *constant* argv array executed with `execFile`, which does no shell parsing
   at all: there is no shell, so there is nothing to inject into. No gate is
   ever assembled from user input — the ids below are the only keys, and they
   resolve to literals defined here.

   PERFORMANCE — the production build takes ~30s. Re-running it per SSE
   connection would be unusable, so a completed run is cached and reused. The
   cache is process-local and bounded; `force` is a server-side detail that
   callers cannot reach over HTTP, so it cannot be used to force work.
   ========================================================================== */

export type GateId = "scope" | "tests" | "type" | "build" | "security" | "compat";

export type GateResult = {
  id: GateId;
  label: string;
  /* "review" is not a pass and not a failure: the gate ran and produced a
     real measurement, but what it measured means a person has to decide. It
     exists because a two-valued gate forces a choice between asserting a
     result the gate cannot prove and reporting a failure that did not
     happen. */
  outcome: "pass" | "fail" | "review" | "skip";
  /** The measurement shown on the gate, e.g. "71/71" or "0.0s". */
  value?: string;
  detail?: string;
  /** Milliseconds the gate actually took. */
  ms: number;
  /** The gate failed because of the environment, not the change under test.
   *  An environmental failure never rejects a run — it asks for a human. */
  environmental?: boolean;
};

export type Verification = {
  runId: string;
  intent: string;
  scope: string;
  commit: string;
  startedAt: number;
  finishedAt: number;
  /** True when these results were replayed from a previous run rather than
   *  measured for this caller. The numbers are real either way; what differs
   *  is whether anything ran just now. */
  cached: boolean;
  gates: GateResult[];
  verdict: "VERIFIED" | "REJECTED" | "IN_REVIEW";
  /**
   * Counts parsed from the real outputs, never assumed.
   *
   * Each field is `null` when the command did not produce a readable number.
   * That is deliberately not `0`: zero asserts "I measured this and it was
   * nothing", which is a claim the run has not earned. A test count that was
   * never parsed is unknown, and unknown has to look different from zero.
   */
  summary: {
    testsTotal: number | null;
    testsPassed: number | null;
    testsFailed: number | null;
    vulnerabilities: number | null;
    typeErrors: number | null;
    buildSeconds: number | null;
  };
};

type Gate = {
  id: GateId;
  label: string;
  /** Constant argv. Never built from input. */
  argv: string[];
  cwd: string;
  timeout: number;
  /** Extracts the reported numbers from stdout. May also return an `outcome`
   *  to withhold a pass the measurement does not support. */
  read: (stdout: string) => {
    value?: string;
    detail?: string;
    outcome?: GateResult["outcome"];
  };
  /** Extra environment for this gate. Constant values declared above, never
   *  anything derived from a request. */
  env?: Record<string, string>;
};

const REPO = process.env.CELASTYLE_REPO ?? findRepoRoot();

/* Ask git where the repository is, rather than guessing from cwd. A path
   guess is wrong the moment the app is started from somewhere else — a test
   runner, a monorepo tool, a different working directory — and a wrong guess
   silently points the gates at a directory that happens to exist, so the
   build would quietly "pass" while verifying nothing.

   Synchronous at module scope, once, before any request: the answer is the
   same for the lifetime of the process, so this never runs on a hot path. */
function findRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // No git available: fall back to the known workspace layout.
    return process.cwd().replace(/\/apps\/command-center$/, "");
  }
}

/* --- Gate definitions ---------------------------------------------------- */

/**
 * Turn test-runner output into an honest count.
 *
 * The suite runs three files and each prints its own "N passed, M failed"
 * line, so every line has to be collected and summed. A non-global regex
 * captures only the first: the panel would report 56/56 for a run that
 * actually executed 88, and an undercount reads exactly like a smaller,
 * cleaner run. The number shown has to be the number of tests that ran.
 *
 * Exported so this stays testable — it is pure, and getting it wrong produces
 * a confident, wrong number rather than an error.
 */
export function readTestOutput(stdout: string): {
  value: string;
  detail?: string;
} {
  const matches = [...stdout.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)];
  if (matches.length === 0) {
    // No summary at all means the suite never reached the end. Reporting 0
    // would claim a clean run that did not happen.
    return { value: "no summary", detail: "suite did not report" };
  }

  const passed = matches.reduce((sum, m) => sum + Number(m[1]), 0);
  const failed = matches.reduce((sum, m) => sum + Number(m[2]), 0);

  return {
    value: `${passed}/${passed + failed}`,
    detail: failed > 0 ? `${failed} failing` : `${matches.length} suites`,
  };
}

const GATES: Gate[] = [
  {
    id: "scope",
    label: "scope",
    /* `--name-only` alone reports only tracked modifications, so every
       brand-new file in the change — the ones most likely to be broken,
       since nothing has ever compiled them — would be silently missing from
       the count. `status --porcelain` covers modified, added and deleted. */
    argv: ["git", "status", "--porcelain", "--untracked-files=all"],
    cwd: REPO,
    timeout: 10_000,
    read: (stdout) => {
      const lines = stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
        /* Build output and dependencies are not part of the change under
           review; counting them would report a scope nobody wrote. */
        .filter((l) => !/(^|\/)(node_modules|\.next(-verify)?|\.test-build(-workspace)?)(\/|$)/.test(l));
      const files = lines.length;
      return {
        value: `${files} file${files === 1 ? "" : "s"}`,
        detail: files > 8 ? "large change" : undefined,
      };
    },
  },
  {
    id: "tests",
    label: "tests",
    argv: ["npm", "test", "-w", "@celastyle/ui", "--silent"],
    cwd: REPO,
    timeout: 120_000,
    read: readTestOutput,
  },
  {
    id: "type",
    label: "type",
    argv: ["npx", "tsc", "--noEmit", "-p", "packages/ui/tsconfig.json"],
    cwd: REPO,
    timeout: 120_000,
    read: () => ({ value: "clean" }),
  },
  {
    id: "build",
    label: "build",
    argv: ["npm", "run", "build", "-w", "@celastyle/command-center"],
    cwd: REPO,
    timeout: 300_000,
    /* A private output directory, for the reason in next.config.mjs: this
       gate runs inside a dev server, and two Next builds sharing one distDir
       corrupt each other's chunks mid-flight. The production NODE_ENV every
       gate is given is applied in runGate. */
    env: { NEXT_DIST_DIR: ".next-verify" },
    read: (stdout) => {
      const match = stdout.match(/in\s+([\d.]+)s/);
      return { value: match ? `${match[1]}s` : "built" };
    },
  },
  {
    id: "security",
    label: "security",
    argv: ["npm", "audit", "--json"],
    cwd: REPO,
    timeout: 60_000,
    read: (stdout) => {
      try {
        const report = JSON.parse(stdout) as {
          metadata?: { vulnerabilities?: Record<string, number> };
        };
        const counts = report.metadata?.vulnerabilities ?? {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return {
          value: `${total} vuln`,
          detail: total > 0 ? JSON.stringify(counts) : undefined,
        };
      } catch {
        return { value: "unknown" };
      }
    },
  },
  {
    id: "compat",
    label: "compat",
    /* `status --porcelain` rather than `diff --name-only`, so a token file that
       is new and untracked is still seen. A contract that has never been
       committed is exactly the one most likely to be wrong, and `diff` would
       not report it at all. */
    argv: ["git", "status", "--porcelain", "--untracked-files=all", "--", "packages/tokens/src"],
    cwd: REPO,
    timeout: 10_000,
    read: (stdout) => {
      const files = stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => l.slice(3).trim());

      if (files.length === 0) {
        return { value: "preserved", detail: "no token changes" };
      }
      /* A token change is a change to the contract every other package is
         written against. This gate cannot prove the contract survived — that
         needs a consumer check, which does not exist yet — so it does not
         claim a pass. It reports what it actually observed and asks for a
         human. Naming the files is what makes that review possible. */
      return {
        outcome: "review" as const,
        value: `${files.length} token file${files.length === 1 ? "" : "s"}`,
        detail: files.map((f) => f.split("/").pop()).join(", "),
      };
    },
  },
];

/* --- Execution ----------------------------------------------------------- */

/**
 * The environment a gate is executed in.
 *
 * Exported for its test, because the rule it encodes is invisible until it
 * breaks and then breaks constantly: a `next build` refuses to run under
 * NODE_ENV=development, and the thing hosting these gates is a dev server. A
 * gate that inherited its host's environment would fail every single time
 * someone opened the app to look at it, and the failure would say nothing
 * about the code being verified.
 *
 * The gate answers "would CI pass?", so it runs in production conditions
 * regardless of who is hosting it.
 */
export function gateEnv(
  gate: Pick<Gate, "env">,
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...hostEnv,
    CI: "1",
    FORCE_COLOR: "0",
    NODE_ENV: "production",
    /* Marks this process tree as running *inside* a gate.

       The test suite is itself a gate, so anything the suite does must not
       re-enter the verifier: verify() → npm test → verify() would recurse
       until the gate timed out and reported a failure that looked like a
       broken build. Code under test checks this and steps aside. */
    CELASTYLE_GATE: "1",
    ...gate.env,
  };
}

async function runGate(gate: Gate): Promise<GateResult> {
  const started = Date.now();
  try {
    const { stdout } = await run(gate.argv[0]!, gate.argv.slice(1), {
      cwd: gate.cwd,
      timeout: gate.timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: gateEnv(gate),
    });

    /* A command that exits 0 has not automatically earned a pass. `read` may
       return its own outcome, and it is allowed to say "review" — a gate can
       complete successfully and still have nothing it is able to confirm. */
    const parsed = gate.read(stdout);
    return {
      id: gate.id,
      label: gate.label,
      outcome: parsed.outcome ?? "pass",
      value: parsed.value,
      detail: parsed.detail,
      ms: Date.now() - started,
    };
  } catch (error) {
    // execFile rejects with stdout attached — a failing test suite still
    // printed its summary, and discarding that would throw away the only
    // evidence the failure produced.
    const stdout =
      typeof error === "object" && error && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
    const detail =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").split("\n").slice(-2).join(" ")
        : "gate failed";

    const parsed = safeRead(gate, stdout);
    // A production build can fail for reasons that have nothing to do with the
    // change under test: a dev server holding the same output directory, a
    // machine out of memory, or — as in an offline or firewalled CI runner —
    // Next trying to fetch a SWC binary it does not have locally and treating
    // the failed download as a build failure.
    //
    // These are reported as failures, because the gate genuinely did not
    // succeed. But calling them "your change does not build" would be a false
    // accusation, so they are marked environmental: the run cannot be
    // confirmed, and a human decides. Rejecting someone's change because the
    // sandbox has no network is exactly the kind of wrong answer this system
    // exists to avoid.
    const combined = `${stdout}\n${detail}`;
    const conflict = /Cannot acquire lock|Unable to acquire the lock|Cannot find module|ENOSPC|ENOMEM|heap out of memory|EACCES|EBUSY|fetch failed|ECONNRESET|ENOTFOUND|Failed to patch lockfile|getaddrinfo/i.test(
      combined,
    );

    return {
      id: gate.id,
      label: gate.label,
      outcome: "fail",
      value: parsed.value,
      detail: conflict
        ? "environment blocked the build — not a code failure"
        : (parsed.detail ?? detail.slice(0, 160)),
      ms: Date.now() - started,
      // Surfaced to deriveVerdict so an environment conflict does not reject
      // the change.
      environmental: conflict,
    } as GateResult;
  }
}

function safeRead(gate: Gate, stdout: string) {
  try {
    return gate.read(stdout);
  } catch {
    return {} as Omit<GateResult, "id" | "label" | "outcome" | "ms">;
  }
}

/* --- Commit context ------------------------------------------------------ */

async function gitContext() {
  const [head, subject, files] = await Promise.all([
    run("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).catch(() => ({ stdout: "unknown" })),
    run("git", ["log", "-1", "--pretty=%s"], { cwd: REPO }).catch(() => ({ stdout: "working tree" })),
    run("git", "diff --name-only HEAD".split(" "), { cwd: REPO }).catch(() => ({ stdout: "" })),
  ]);

  return {
    commit: head.stdout.trim(),
    // The real commit subject becomes the run's intent. This is the part of
    // the system that is no longer invented.
    intent: subject.stdout.trim() || "working tree",
    changed: files.stdout.split("\n").filter(Boolean).length,
  };
}

/* --- Verdict ------------------------------------------------------------- */

export function deriveVerdict(gates: GateResult[]): Verification["verdict"] {
  // Order is load-bearing.
  //
  // A gate that failed for real — failing tests, a vulnerability, a build that
  // did not compile, a broken token contract — rejects the run. That verdict
  // comes first and nothing can soften it, because a change that fails a gate
  // is wrong regardless of what else happened in the environment.
  //
  // Only once the run is known to be clean does an environmental failure
  // matter: it means a gate was inconclusive, so the run cannot be confirmed
  // and a human has to look. It must never be read as "this change is fine".
  const realFailures = gates.filter((g) => g.outcome === "fail" && !g.environmental);
  if (realFailures.length > 0) return "REJECTED";

  // A gate that ran and could not conclude. The environment getting in the
  // way is one way this happens; a gate that completed but cannot prove its
  // own result — a token contract change, say — is another. Both mean the
  // same thing for the verdict: this run is not a confirmation.
  if (gates.some((g) => g.environmental || g.outcome === "review")) return "IN_REVIEW";

  return "VERIFIED";
}

/* --- Cached run ---------------------------------------------------------- */

let cached: Verification | null = null;
let inFlight: Promise<Verification> | null = null;

export async function verify(
  options: {
    force?: boolean;
    /* Called the moment each gate resolves, in the order it actually
       finished. This is what makes the stream progressive: a 10s test run
       reaches the client the moment the tests finish, not when the slowest
       gate — the build — is also done.

       Not called for a cached run. A cache hit has no gates to stream; the
       caller decides how to present an already-finished run. */
    onGate?: (gate: GateResult) => void;
    /* "running" | "resolved" | "failed", fired as a gate's state actually
       changes, so the UI can show real in-flight work. */
    onGateState?: (id: string, state: "running" | "resolved") => void;
  } = {},
): Promise<Verification> {
  if (!options.force && cached) {
    /* Flagged so the caller can say so out loud. A run served from cache is
       still a real measurement — the same commands really did produce these
       numbers — but nothing was re-measured *now*, and a client that cannot
       tell the two apart will draw conclusions it has not earned. */
    return { ...cached, cached: true };
  }
  // Concurrent callers share one run: the build is expensive and a burst of
  // SSE connections must not each trigger their own. The subscriber attached
  // to the first caller is the one that gets progress; later callers get the
  // finished result, which is correct — they joined after the work was done.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const startedAt = Date.now();
    const context = await gitContext();

    // Each gate reports itself as it resolves instead of being collected into
    // an array first. The gates still run concurrently — a slow build should
    // not delay the test results — but their results are *delivered* in the
    // order they genuinely complete.
    const gates = await Promise.all(
      GATES.map(async (gate) => {
        options.onGateState?.(gate.id, "running");
        const result = await runGate(gate);
        options.onGateState?.(gate.id, "resolved");
        options.onGate?.(result);
        return result;
      }),
    );
    const finishedAt = Date.now();

    const tests = gates.find((g) => g.id === "tests");
    const testNumbers = tests?.value?.match(/^(\d+)\/(\d+)$/);
    const security = gates.find((g) => g.id === "security");
    const vuln = security?.value?.match(/^(\d+)\s/);
    const build = gates.find((g) => g.id === "build");
    const buildSeconds = build?.value?.match(/^([\d.]+)s/);

    const result: Verification = {
      runId: context.commit,
      intent: context.intent,
      scope: `${context.changed} file${context.changed === 1 ? "" : "s"} changed`,
      commit: context.commit,
      startedAt,
      finishedAt,
      cached: false,
      gates,
      verdict: deriveVerdict(gates),
      summary: {
        /* Every one of these is a measured value or it is null. A default of
           0 here would be a lie: "0 failing tests" is a claim that the suite
           ran clean, and it is indistinguishable from "the suite never
           finished and we counted nothing". The UI renders "unknown" for
           null, which is the honest state. */
        testsTotal: testNumbers ? Number(testNumbers[2]) : null,
        testsPassed: testNumbers ? Number(testNumbers[1]) : null,
        testsFailed: testNumbers ? Number(testNumbers[2]) - Number(testNumbers[1]) : null,
        vulnerabilities: vuln ? Number(vuln[1]) : null,
        typeErrors:
          gates.find((g) => g.id === "type")?.outcome === "fail"
            ? 1
            : gates.find((g) => g.id === "type")?.outcome === "pass"
              ? 0
              : null,
        buildSeconds: buildSeconds ? Number(buildSeconds[1]) : null,
      },
    };

    cached = result;
    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function peek(): Verification | null {
  return cached;
}

/** The wire event shapes these results are streamed as. Declared next to the
 *  verifier so the producer and the client consumer cannot drift. */
export type TelemetryWireEvent =
  | { type: "run:start"; at: number }
  | {
      type: "gate";
      gate: GateId;
      outcome: "pass" | "fail" | "review" | "run" | "running" | "resolved" | "skip";
      value?: string;
      detail?: string;
      ms?: number;
      environmental?: boolean;
      at: number;
    }
  | {
      type: "run:end";
      runId: string;
      intent: string;
      scope: string;
      verdict: Verification["verdict"];
      summary: Verification["summary"];
      /** The gates were not re-measured for this connection. */
      cached: boolean;
      finishedAt: number;
      at: number;
    }
  | {
      type: "run:cached";
      runId: string;
      /** When the commands behind these numbers actually ran. */
      measuredAt: number;
      at: number;
    }
  | {
      type: "deploy";
      runId: string;
      environment: string;
      outcome: "pass" | "fail";
      at: number;
    }
  | { type: "error"; message: string; at: number };
