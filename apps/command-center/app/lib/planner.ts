import {
  evaluatePlan,
  DEFAULT_LIMITS,
  type Plan,
  type PlanNode,
  type PlanLimits,
  type PolicyVerdict,
} from "./policy-engine";
import {
  executeCognitiveStep,
  type ProposedStep,
  type StepResult,
  type Executor,
  type Verifier,
} from "./cognitive-pipeline";
import { EventLedger, type LedgerEntry } from "./event-ledger";
import type { ApprovalFn } from "./execution-authority";

/* =============================================================================
   Planner
   -----------------------------------------------------------------------------
   The component at the top of the loop, and the one with the least power.

   It proposes. It cannot authorise, execute, verify, or record. Every step
   it produces is handed to the pipeline, which checks it against the
   authority anyway — a planner able to talk the pipeline out of that check
   would be a back door, and there is nothing here that could do it even by
   accident. Its only real power is the ability to propose a great deal at
   once, which is exactly why the policy engine has to read the whole plan
   before the first step runs.

   What this module does *not* do is invent. A deterministic planner cannot
   understand a goal, and one that pretended to would be a costume. The
   decomposition is supplied from outside — an LLM in production, a fixed
   list in the tests — and what lives here is the part that has to be right
   regardless of who proposed it: the ordering, the bounds, the graph, and
   the decision to stop.
   ========================================================================== */

export type Planned = { ok: true; plan: Plan; verdict: PolicyVerdict };

export type PlanRejection = { ok: false; verdict: PolicyVerdict };

export type ReplanStop =
  | "no_proposer"
  | "exhausted"
  | "no_change"
  | "refused";

export type ReplanOutcome =
  | Planned
  | PlanRejection
  | { ok: false; stop: ReplanStop; reason: string };

export type StepFailure = { stepId: string; result: StepResult; entry?: LedgerEntry };

export type PlanOutcome = {
  plan: Plan;
  /** Every step result across every round, in the order they ran. */
  steps: StepResult[];
  completed: string[];
  /** Every failure, including the ones that led to a replan. */
  failures: StepFailure[];
  replans: number;
  status: "completed" | "denied" | "failed" | "halted" | "rejected";
  reason?: string;
};

/** A refusal, as a sentence. Written with an explicit in-operator check
 *  rather than a ternary on `allowed`, because narrowing a discriminated
 *  union through a ternary depends on the compiler setting, and the same
 *  source has to compile under both the app's isolatedModules and the test
 *  build's config. One helper, one rule, both configs. */
function describeVerdict(verdict: PolicyVerdict): string {
  return "reason" in verdict ? verdict.reason : "allowed";
}

const toStep = (node: PlanNode): ProposedStep => ({
  id: node.id,
  action: node.action,
  skill: node.skill,
  payload: node.payload,
  expected: node.expected,
});

/**
 * Topologically order a plan, breaking ties by declaration order.
 *
 * The ordering is not decoration. The executor walks steps in this order and
 * refuses to run a step whose dependencies have not succeeded, so a plan
 * whose order does not reflect its edges cannot execute as written. Ties are
 * broken by declaration rather than by anything derived, because a plan that
 * reorders itself between two identical runs is impossible to test and
 * impossible for a person to read off a diff.
 */
export function orderPlan(steps: PlanNode[]): PlanNode[] {
  const known = new Set(steps.map((s) => s.id));
  const ordered: PlanNode[] = [];
  const placed = new Set<string>();
  const remaining = [...steps];

  /* A step is placed only once every dependency is placed, so the result is
     a linear extension of the dependency order. A dependency naming a step
     that is not in the plan is treated as satisfied: evaluatePlan refuses
     that case first, and an orderer that hung on malformed input would be a
     worse failure than the malformed plan it was given. */
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; ) {
      const step = remaining[i]!;
      if (step.dependsOn.every((dep) => placed.has(dep) || !known.has(dep))) {
        ordered.push(step);
        placed.add(step.id);
        remaining.splice(i, 1);
        progress = true;
      } else {
        i += 1;
      }
    }
  }

  // Whatever is left is in a cycle. Appended rather than dropped, so a caller
  // that skipped evaluation still sees every step it proposed.
  ordered.push(...remaining);
  return ordered;
}

/**
 * Assemble a plan and check it before any of it is offered.
 *
 * The policy check happens here, once, over the whole plan. Checking after
 * the first step would be checking the wrong thing: a plan that is over its
 * read budget has already read something by the time anyone notices.
 */
export function buildPlan(input: {
  goal: string;
  goalRisk?: "low" | "medium" | "high";
  steps: PlanNode[];
  basedOn?: Plan["basedOn"];
  /**
   * Which re-form this is. Passed explicitly rather than derived from
   * `basedOn`: inferring it as "1 if there is a history, else 0" makes every
   * replan look like the first one, so a plan re-formed forever still reads
   * as attempt 1 and the bound below never fires. The counter has to be
   * carried forward by whoever increments it.
   */
  attempt?: number;
  limits?: PlanLimits;
}): Planned | PlanRejection {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const plan: Plan = {
    goal: input.goal,
    goalRisk: input.goalRisk,
    steps: orderPlan(input.steps),
    attempt: input.attempt ?? 0,
    basedOn: input.basedOn,
  };
  const verdict = evaluatePlan(plan, limits);
  return verdict.allowed ? { ok: true, plan, verdict } : { ok: false, verdict };
}

/* ── reading the ledger ─────────────────────────────────────────────────── */

export type FailureSignal = {
  outcome: string;
  code?: string;
  reason?: string;
  entryId: string;
};

/**
 * Recover a step's failure signal from the ledger.
 *
 * The planner is a reader here and never a writer. A record of what went
 * wrong already exists and is already hashed; rebuilding one from the
 * returned StepResult would be a second, unverified account of the same
 * event, and the two could disagree. So the ledger is asked. If it does not
 * hold the entry, that is reported as null rather than papered over with a
 * reason invented from the status alone.
 */
export function readFailure(ledger: EventLedger, stepId: string): FailureSignal | null {
  const entries = ledger.all();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || payload.stepId !== stepId) continue;
    return {
      outcome: typeof payload.outcome === "string" ? payload.outcome : String(entry.verifier_result),
      code: typeof payload.reasonCode === "string" ? payload.reasonCode : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      entryId: entry.id,
    };
  }
  return null;
}

/* ── which failures may be planned around ───────────────────────────────── */

/**
 * Statuses a replan is allowed to respond to.
 *
 * A denial is the authority refusing one phrasing of a step. Re-forming the
 * plan to ask for a *different* phrasing of the same thing is legitimate —
 * a path outside a subdirectory, say, where a different path inside it does
 * the job. What is not legitimate is re-planning to get a refusal to go
 * away, and the distinction is not drawn by this function. It is drawn by
 * the proposal having to pass the same policy engine and the same authority,
 * and by the ledger holding both the refusal and the alternative.
 *
 * `record_failed` and `rollback_failed` are not on this list, and that is the
 * most important line in the module. Both mean the state of the workspace is
 * unknown: in one case a change happened with no record of it, in the other
 * a change was attempted and the undo failed. Re-planning on top of that
 * would compound an untracked change with a second one, and would spend the
 * rollback handle that is the only evidence the first one exists.
 */
export function isReplannable(status: string): boolean {
  return (
    status === "denied" ||
    status === "execution_refused" ||
    status === "execution_failed" ||
    status === "verification_failed"
  );
}

/* ── replanning ─────────────────────────────────────────────────────────── */

export type RunDeps = {
  executor: Executor;
  verifier: Verifier;
  ledger: EventLedger;
  approve?: ApprovalFn;
  /** Asked for an alternative after a replannable failure. Supplied by the
   *  host: a planner that invented its own alternatives would be the thing
   *  being optimised and the thing doing the criticising. */
  replan?: (context: {
    plan: Plan;
    failure: StepFailure;
    signal: FailureSignal | null;
    attempt: number;
  }) => { goal?: string; steps: PlanNode[] } | null;
  limits?: PlanLimits;
};

/**
 * Re-form a plan after a failure, under bounds.
 *
 * Three ways this says stop, all the same decision — continuing would be
 * motion without progress — and all three are reported rather than assumed:
 * no strategy to ask, the bound reached, or a proposal identical to the one
 * that just failed.
 */
export function replan(input: {
  plan: Plan;
  failure: StepFailure;
  signal: FailureSignal | null;
  propose: RunDeps["replan"];
  limits?: PlanLimits;
}): ReplanOutcome {
  const limits = input.limits ?? DEFAULT_LIMITS;

  if (!input.propose) {
    return {
      ok: false,
      stop: "no_proposer",
      reason: "no replanning strategy was supplied, so there is no independent opinion to ask",
    };
  }
  if (input.plan.attempt >= limits.maxReplans) {
    return {
      ok: false,
      stop: "exhausted",
      reason: `the plan has already been re-formed ${input.plan.attempt} time(s), at the bound of ${limits.maxReplans}`,
    };
  }

  const proposal = input.propose({
    plan: input.plan,
    failure: input.failure,
    signal: input.signal,
    attempt: input.plan.attempt + 1,
  });
  if (!proposal) {
    return { ok: false, stop: "no_proposer", reason: "the strategy declined to propose an alternative" };
  }

  const rebuilt = buildPlan({
    goal: proposal.goal ?? input.plan.goal,
    goalRisk: input.plan.goalRisk,
    steps: proposal.steps,
    attempt: input.plan.attempt + 1,
    basedOn: {
      entryId: input.signal?.entryId ?? input.failure.entry?.id ?? "unknown",
      status: input.failure.result.status,
      reason: input.signal?.reason ?? input.failure.result.authorityReason,
    },
    limits,
  });
  if (!rebuilt.ok) return rebuilt;

  /* A proposal identical to the one that just failed will fail the same
     way. Refusing the no-op is what turns an unbounded loop into a bounded
     number of rounds, and it is checked here rather than trusted to the
     strategy to have noticed. */
  if (sameShape(rebuilt.plan, input.plan)) {
    return {
      ok: false,
      stop: "no_change",
      reason: "the strategy returned a plan identical to the one that just failed; continuing would repeat it",
    };
  }
  return rebuilt;
}

/** Same steps, same order. Goal and risk are ignored: a plan that renames
 *  its goal while repeating its steps has not changed anything. */
function sameShape(a: Plan, b: Plan): boolean {
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((s, i) => s.id === b.steps[i]?.id && s.action === b.steps[i]?.action);
}

/**
 * Does `node` depend on `id`, directly or through other steps?
 *
 * Transitive, because the graph is what a person reads to work out the
 * blast radius of a failure. Marking only the immediate dependents would say
 * a step was unaffected when three edges away it plainly was not. Cycle-safe
 * with a visited set: evaluatePlan refuses cycles, but the marking code
 * runs before that guarantee is assumed everywhere else.
 */
function transitivelyDependsOn(node: PlanNode, id: string, plan: Plan): boolean {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (current: string): boolean => {
    if (current === id) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return (byId.get(current)?.dependsOn ?? []).some(walk);
  };
  return node.dependsOn.some(walk);
}

/* ── running ────────────────────────────────────────────────────────────── */

/**
 * Run a plan, honouring the graph, re-forming it when a step fails.
 *
 * Three bounds, and only the first is the obvious one:
 *
 * 1. Steps are not run when a dependency failed. "Write the summary after
 *    the data is collected" must not write the summary when the collection
 *    was refused. Skipping is the correct behaviour rather than error
 *    handling — the alternative is running step 3 of a plan whose premise no
 *    longer holds.
 *
 * 2. Replans are bounded. This, not the plan size, is the loop that actually
 *    runs forever: plan → fail → replan → fail → replan. A 24-step plan
 *    re-formed three times executes 96 steps and stops; without this bound
 *    the same 24 steps execute until something else crashes.
 *
 * 3. A replan that does not change the plan is refused, which is what makes
 *    bound 2 reachable in a bounded number of rounds rather than by luck.
 */
export async function runPlan(initial: Plan, deps: RunDeps): Promise<PlanOutcome> {
  const limits = deps.limits ?? DEFAULT_LIMITS;

  let plan = initial;
  const steps: StepResult[] = [];
  const completed: string[] = [];
  const failures: StepFailure[] = [];
  let replans = 0;

  const first = evaluatePlan(plan, limits);
  if (!first.allowed) {
    return {
      plan,
      steps,
      completed,
      failures,
      replans,
      status: "rejected",
      reason: `plan refused before it ran: ${describeVerdict(first)}`,
    };
  }

  for (;;) {
    /* Per round: what succeeded and what failed in this plan. A replan
       clears them, because a new plan may legitimately revisit a step the
       previous one gave up on. */
    const broken = new Set<string>();
    let replannedThisRound = false;

    for (const node of plan.steps) {
      const blocked = node.dependsOn.filter((dep) => broken.has(dep));
      if (blocked.length > 0) {
        broken.add(node.id);
        failures.push({
          stepId: node.id,
          result: {
            status: "denied",
            stepId: node.id,
            action: node.action,
            authorityReason: `not attempted: ${blocked.join(", ")} did not succeed`,
          },
        });
        continue;
      }

      const result = await executeCognitiveStep(toStep(node), {
        executor: deps.executor,
        verifier: deps.verifier,
        ledger: deps.ledger,
        approve: deps.approve,
      });
      steps.push(result);

      if (result.status === "authorized_and_verified") {
        if (!completed.includes(node.id)) completed.push(node.id);
        continue;
      }

      broken.add(node.id);
      failures.push({ stepId: node.id, result, entry: result.ledgerEntry });

      /* Everything downstream of a failed step is reported as not attempted,
         before any decision about replanning. A dependency the runner merely
         skipped would look the same as one it ran and lost track of, and the
         whole point of the graph is that a person can see which steps a
         failure took with it. This is also what makes the dependency edges
         do anything: without it a failed step simply ends the run and the
         rest of the plan is never discussed again. */
      for (const later of plan.steps) {
        if (later.id === node.id || broken.has(later.id)) continue;
        if (!transitivelyDependsOn(later, node.id, plan)) continue;
        broken.add(later.id);
        failures.push({
          stepId: later.id,
          result: {
            status: "denied",
            stepId: later.id,
            action: later.action,
            authorityReason: `not attempted: it depends on "${node.id}", which ended as ${result.status}`,
          },
        });
      }

      /* Unknown state ends the run. No proposal is asked for, because any
         answer would be built on a workspace nobody can describe. */
      if (result.status === "record_failed" || result.status === "rollback_failed") {
        return {
          plan,
          steps,
          completed,
          failures,
          replans,
          status: "halted",
          reason:
            `step "${node.id}" ended as ${result.status}, which means the state of the workspace cannot be described. ` +
            `No replan was attempted: re-planning would add a second untracked change and spend the only handle on the first.`,
        };
      }

      if (!isReplannable(result.status)) {
        return {
          plan,
          steps,
          completed,
          failures,
          replans,
          status: result.status === "denied" || result.status === "execution_refused" ? "denied" : "failed",
          reason: `step "${node.id}" ended as ${result.status}${
            result.authorityReason ? `: ${result.authorityReason}` : ""
          }`,
        };
      }

      const signal = readFailure(deps.ledger, node.id);
      const alternative = replan({
        plan,
        failure: { stepId: node.id, result, entry: result.ledgerEntry },
        signal,
        propose: deps.replan,
        limits,
      });

      if (!alternative.ok) {
        /* Two different refusals land here and both must be explainable: the
           strategy stopped, or the policy engine refused the new plan. A
           caller that gets "re-planning stopped" with no reason cannot tell
           "asked and it declined" from "asked and it was wrong". */
        const why =
          "verdict" in alternative
            ? `the alternative plan was refused: ${describeVerdict(alternative.verdict)}`
            : alternative.reason;
        return {
          plan,
          steps,
          completed,
          failures,
          replans,
          status: result.status === "denied" || result.status === "execution_refused" ? "denied" : "failed",
          reason: `step "${node.id}" failed (${result.status}) and re-planning stopped: ${why}`,
        };
      }

      plan = alternative.plan;
      replans += 1;
      replannedThisRound = true;
      break; // re-plan: the rest of the old plan is not the plan any more
    }

    /* A round that reached the end of its plan without a replan is done. The
       flag rather than a counter, so a plan that legitimately completes on
       its second attempt is not mistaken for one that is still going. */
    if (!replannedThisRound) {
      return { plan, steps, completed, failures, replans, status: "completed" };
    }
  }
}
