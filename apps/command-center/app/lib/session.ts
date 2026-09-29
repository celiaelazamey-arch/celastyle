import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventLedger, type LedgerEntry } from "./event-ledger";
import { IsolatedExecutor } from "./isolated-executor";
import { runPlan, type PlanOutcome, type RunDeps } from "./planner";
import type { PlanNode, PolicyVerdict } from "./policy-engine";
import type { Verifier, Executor } from "./cognitive-pipeline";
import type { PlanLimits } from "./policy-engine";

/* =============================================================================
   Agent Session
   -----------------------------------------------------------------------------
   The runtime. Everything built so far was a library: correct, tested, and
   reachable from nothing. This module is where the pieces are joined into a
   path a request can actually travel.

   It exists because the wiring is where the guarantees stop being automatic.
   A ledger with no sink is a ledger whose durability is untested at runtime;
   a planner with no caller is a planner that cannot fail in the way its
   tests say it fails. Assembly is code, and code needs tests too.

   Three things are decided here and nowhere else:

   1. Where the ledger lives. One file, append-only, opened for append on
      every write. A restart resumes from it rather than starting clean,
      because a chain that forgets its own history on restart is a log.

   2. What verifies. The pipeline's `Verifier` contract asks "is this step's
      stated expectation observably true right now". It is a re-read of real
      state, never a re-run of the tool's own claim. This implementation is
      the only place that knows how to ask that question, and it is the
      independent half of the loop: the executor says what it did, this
      says what is true.

   3. What a client may ask for. A goal, and a proposal. Never a tool, never
      a payload, never an argv. Those come from the proposal, which the
      policy engine reads and the authority checks — but the client cannot
      name a skill and have it run, because a client that can name a skill
      is a client that can name the reserved namespace too.
   ========================================================================== */

export type AgentRequest = {
  goal: string;
  /** Declared by the client and checked as metadata, never parsed from the
   *  goal string. A goal whose risk is not declared cannot be weighed
   *  against the steps meant to achieve it. */
  goalRisk?: "low" | "medium" | "high";
  /** The proposed decomposition. The client proposes; the planner bounds
   *  it and the policy engine judges it. */
  steps: PlanNode[];
  /** Propose an alternative after a replannable failure. Optional; without
   *  one the run ends rather than improvising. */
  replan?: RunDeps["replan"];
  approve?: RunDeps["approve"];
};

export type SessionSummary = {
  ledgerPath: string;
  /** Entries in the chain, including everything before this session. */
  entries: number;
  head: string;
  /** True when this process found a previous chain and continued it. */
  resumed: boolean;
  chainOk: boolean;
};

export type SessionRun = {
  summary: SessionSummary;
  outcome: PlanOutcome;
};

/**
 * A verifier that re-reads the filesystem instead of trusting the executor.
 *
 * The expectation string is the contract, and it is deliberately narrow in
 * what it understands: `<path> exists with content "<text>"`. Anything else
 * is reported as unverifiable rather than assumed true. A verifier that
 * shrugged and passed an expectation it did not understand would be exactly
 * the failure this whole loop exists to prevent — an unverifiable claim
 * being recorded as a verified one.
 */
export class FileSystemVerifier implements Verifier {
  async verify(step: { payload: unknown; expected: string }): Promise<{
    ok: boolean;
    evidence: unknown;
  }> {
    const path = (step.payload as { path?: unknown })?.path;
    if (typeof path !== "string") {
      return {
        ok: false,
        evidence: { checked: false, reason: "the step has no path to check" },
      };
    }

    const match = /^(.*?) exists(?: with content "(.*)")?$/.exec(step.expected);
    if (!match) {
      return {
        ok: false,
        evidence: {
          checked: false,
          reason: `this verifier does not understand the expectation "${step.expected}"`,
        },
      };
    }
    const [, expectedPath, content] = match;
    if (expectedPath !== path) {
      return {
        ok: false,
        evidence: {
          checked: false,
          reason: `the expectation names ${expectedPath} but the step wrote ${path}`,
        },
      };
    }

    let actual: string | null = null;
    try {
      actual = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    } catch {
      actual = null;
    }

    const ok = content === undefined ? actual !== null : actual === content;
    return {
      ok,
      // The evidence is the observation itself, not a boolean about it. A
      // record saying "true" with nothing behind it is a claim, and this
      // ledger exists to hold evidence rather than claims.
      evidence: {
        checked: true,
        path,
        expectedContent: content ?? null,
        actualContent: actual,
        exists: actual !== null,
        observedAt: new Date().toISOString(),
      },
    };
  }
}

export class AgentSession {
  private readonly ledger: EventLedger;
  private readonly executor: Executor;
  private readonly verifier: Verifier;
  private resumed: boolean;

  private constructor(
    readonly ledgerPath: string,
    ledger: EventLedger,
    executor: Executor,
    verifier: Verifier,
    resumed: boolean,
  ) {
    this.ledger = ledger;
    this.executor = executor;
    this.verifier = verifier;
    this.resumed = resumed;
  }

  /**
   * Open a session against a ledger file, creating it if absent and
   * continuing it if present.
   *
   * Resuming is the point. A fresh process that opened an empty chain would
   * make the previous run's evidence unfindable, and an evidence store that
   * forgets is indistinguishable from one that was never written.
   */
  static async open(options: {
    ledgerPath: string;
    workerPath?: string;
    verifier?: Verifier;
    limits?: PlanLimits;
  }): Promise<AgentSession> {
    const { ledgerPath } = options;
    mkdirSync(dirname(ledgerPath), { recursive: true });

    const existing = await EventLedger.fromFile(ledgerPath);
    const resumed = existing.length > 0;

    /* Append mode on every write. The file is never opened for truncation,
       so a shorter rewrite cannot silently drop the chain — the property
       the ledger's own header claims and the one that makes resuming safe. */
    const sink = {
      write(line: string) {
        appendFileSync(ledgerPath, line, { encoding: "utf8", flag: "a" });
      },
    };

    const ledger = new EventLedger([...existing.all()], sink);
    const executor = new IsolatedExecutor(
      options.workerPath ? { workerPath: options.workerPath } : {},
    );

    return new AgentSession(
      ledgerPath,
      ledger,
      executor,
      options.verifier ?? new FileSystemVerifier(),
      resumed,
    );
  }

  summary(): SessionSummary {
    const result = this.ledger.verify();
    return {
      ledgerPath: this.ledgerPath,
      entries: this.ledger.length,
      head: result.head,
      resumed: this.resumed,
      chainOk: result.ok,
    };
  }

  /** The chain as it stands, for a caller reading the evidence. */
  entries(): readonly LedgerEntry[] {
    return this.ledger.all();
  }

  /**
   * Run one request end to end and return what actually happened.
   *
   * The order below is the whole path, and each stage is the real module
   * rather than a stand-in: the proposal is bounded and ordered by the
   * planner, judged by the policy engine, and every step of it goes back
   * through the authority before anything is executed.
   */
  async run(request: AgentRequest): Promise<SessionRun> {
    const { buildPlan } = await import("./planner");

    const built = buildPlan({
      goal: request.goal,
      goalRisk: request.goalRisk,
      steps: request.steps,
    });
    if (!built.ok) {
      /* A refused plan is refused before the ledger is touched, so a plan
         the policy engine rejects leaves no trace of ever having been
         proposed. There is nothing to record about a thing that did not
         happen, and an entry saying "this was refused" would be a record of
         the refusal rather than of the plan. */
      return {
        summary: this.summary(),
        outcome: {
          plan: { goal: request.goal, goalRisk: request.goalRisk, steps: request.steps, attempt: 0 },
          steps: [],
          completed: [],
          failures: [],
          replans: 0,
          status: "rejected",
          reason: `the policy engine refused the plan: ${describeRefusal(built.verdict)}`,
        },
      };
    }

    const outcome = await runPlan(built.plan, {
      executor: this.executor,
      verifier: this.verifier,
      ledger: this.ledger,
      approve: request.approve ?? (async () => undefined),
      replan: request.replan,
    });

    return { summary: this.summary(), outcome };
  }
}

/** A refusal as a sentence. Narrowed with an explicit key check rather than
 *  a ternary on `allowed`, which narrows only under some compiler settings
 *  — the same reason planner.ts does it this way. */
function describeRefusal(verdict: PolicyVerdict): string {
  return "reason" in verdict ? verdict.reason : "allowed";
}

/** Default location: beside the app, ignored by git. */
export function defaultLedgerPath(repoRoot: string): string {
  return join(repoRoot, "apps/command-center/.runtime/ledger.jsonl");
}
