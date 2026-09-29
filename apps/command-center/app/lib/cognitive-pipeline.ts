import { authorize, type SkillMeta, type ToolRequest, type ApprovalFn } from "./execution-authority";
import { EventLedger, type LedgerEntry } from "./event-ledger";

/* =============================================================================
   Cognitive Step Pipeline
   -----------------------------------------------------------------------------
   The contract that turns three independent modules into a loop that cannot
   be walked out of.

   The ordering is the whole point, and it is enforced by control flow rather
   than by convention:

       authorize → execute → verify → (rollback) → seal

   Each stage can end the step early, and each of those endings is written to
   the ledger before returning. An attempt that was never authorised is
   evidence too — arguably the most valuable kind, because it is the one
   nobody else records.

   Three things this contract closes that the sketch left open:

   1. The rollback was not recorded. The sketch rolled back and returned,
      leaving a ledger that said "failed" and a filesystem that had briefly
      contained the change. Replaying that ledger would assert nothing had
      happened when a write had occurred and been undone. A rollback is a
      real state transition and gets its own entry.

   2. A failing rollback had no representation. The sketch's status enum
      cannot express "verification failed AND the undo failed", which is the
      most dangerous state in the whole loop: the intended change is absent
      and the workspace is in an unknown condition. `rollback_failed` says so
      instead of burying it.

   3. The denial reason had to be committed, not merely carried. Passing it
      as a side argument would have left the reason outside the hash, so the
      most interesting field in the record would have been the one an
      attacker could edit silently. Reasons go in the payload, which is
      hashed.

   The executor is reachable only through here. It is passed in as a
   dependency rather than imported, so there is no exported function that can
   run a tool without a preceding authorisation decision.
   ========================================================================== */

/* ============================================================================
   Contracts
   ========================================================================= */

export type ProposedStep = {
  id: string;
  /** The tool being invoked, e.g. "write_file". */
  action: string;
  skill: SkillMeta;
  payload: unknown;
  /**
   * What must be observably true afterwards if the step worked. Stated
   * before execution, not derived from it — a verifier told what to expect
   * by the thing it is checking has been told nothing.
   */
  expected: string;
};

/** The isolated arm. Cannot be constructed here; supplied by the host. */
export type Executor = {
  /**
   * Run one action. The skill is part of the call and not optional context:
   * it carries `allowed_directories`, which is what confines the write, and
   * `timeout_ms`, which is the child's budget. An executor invoked without
   * it has no scope to enforce, and the safe reading of "no scope" is
   * refusing every path — so omitting this parameter is not a loose
   * default, it is a total denial that looks like a passing test.
   */
  run(action: string, payload: unknown, skill?: SkillMeta): Promise<unknown>;
  /** Undo a completed run. May itself fail; that is not exceptional. */
  rollback(step: ProposedStep): Promise<void>;
  /**
   * Optional. Called once a step is verified, so an executor holding undo
   * material for work that was never questioned can release it. Without this
   * a long-lived agent accumulates a rollback record for every write it has
   * ever made, which is a slow leak dressed up as a safety feature.
   */
  commit?(step: ProposedStep): void;
};

/** The independent check. Re-reads real state; never trusts the executor. */
export type Verifier = {
  /** Returns whether the expected outcome is observably true, plus the
   *  evidence for that conclusion. Evidence is required: a verdict with no
   *  evidence is a claim, and this pipeline records claims. */
  verify(step: ProposedStep): Promise<{ ok: boolean; evidence: unknown }>;
};

export type StepStatus =
  | "authorized_and_verified"
  | "denied"
  | "execution_failed"
  /** The executor declined: the path was outside scope, the tool refused, or
   *  the child misbehaved. Nothing was written, so there is nothing to roll
   *  back and the workspace is exactly as it was. Distinct from
   *  `execution_failed`, which is a step that started and did not finish. */
  | "execution_refused"
  | "verification_failed"
  /** Verification failed AND the undo failed. The workspace is now unknown. */
  | "rollback_failed"
  /** The work succeeded and the record of it could not be written. The
   *  workspace holds a verified change that nothing proves was approved. */
  | "record_failed";

export type StepResult = {
  status: StepStatus;
  stepId: string;
  action: string;
  /** Present when the authority refused, and hashed into the ledger. */
  authorityReason?: string;
  executionOutput?: unknown;
  verificationEvidence?: unknown;
  /** Every outcome is recorded — except record_failed, where by definition
   *  there is no entry, which is why this is optional rather than asserted
   *  with a cast. A non-null type here would be a lie the compiler could not
   *  catch and every caller would be taught to trust. */
  ledgerEntry?: LedgerEntry;
  /** Set when the ledger itself could not accept the entry. Rare, and
   *  surfaced rather than swallowed, because a step that ran without a
   *  record is the one outcome worse than a failed step. */
  sealError?: string;
};

/* ============================================================================
   The contract
   ========================================================================= */

export type PipelineDeps = {
  executor: Executor;
  verifier: Verifier;
  ledger: EventLedger;
  /** Wired in by the host; omitted means no action can be approved. */
  approve?: ApprovalFn;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Did the executor decline rather than fail?
 *
 * Recognised structurally — an object carrying a `failure` and an `ok` of
 * false — rather than by importing the executor's own type, so the pipeline
 * stays independent of the module that implements it. A duck-typed check
 * that accepts any well-formed refusal keeps a second implementation, or a
 * future one, from having to be taught about this contract explicitly.
 */
function isRefusal(
  output: unknown,
): output is { ok: false; error?: string; failure: { kind: string; reason: string } } {
  if (!output || typeof output !== "object") return false;
  const candidate = output as { ok?: unknown; failure?: { kind?: unknown; reason?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.failure === "object" &&
    candidate.failure !== null &&
    typeof candidate.failure.kind === "string" &&
    typeof candidate.failure.reason === "string"
  );
}

export async function executeCognitiveStep(
  step: ProposedStep,
  deps: PipelineDeps,
): Promise<StepResult> {
  const { executor, verifier, ledger, approve } = deps;

  /* ── 1. Authorisation ───────────────────────────────────────────────────
     Checked before anything observable happens. If this refuses, the executor
     is never touched — which is the property worth testing, because a gate
     that runs the tool and then apologises is not a gate. */
  const request: ToolRequest = { tool: step.action, payload: step.payload };
  const decision = await authorize(request, step.skill, approve);

  if (decision.allowed === false) {
    // The reason is payload, not a side channel, so it is inside the hash.
    const entry = ledger.append({
      action: step.action,
      payload: {
        stepId: step.id,
        outcome: "denied",
        reasonCode: decision.code,
        reason: decision.reason,
        proposedPayload: step.payload,
      },
      verifier_result: "failed",
    });
    return {
      status: "denied",
      stepId: step.id,
      action: step.action,
      authorityReason: decision.reason,
      ledgerEntry: entry,
    };
  }

  /* ── 2. Execution ───────────────────────────────────────────────────────
     Inside its own try, because a throwing executor is a normal outcome and
     must not be distinguishable from a crash to the caller. */
  let executionOutput: unknown;
  try {
    executionOutput = await executor.run(step.action, step.payload, step.skill);
  } catch (error) {
    const entry = ledger.append({
      action: step.action,
      payload: {
        stepId: step.id,
        outcome: "execution_failed",
        error: message(error),
        proposedPayload: step.payload,
      },
      verifier_result: "failed",
    });
    return {
      status: "execution_failed",
      stepId: step.id,
      action: step.action,
      executionOutput: undefined,
      ledgerEntry: entry,
    };
  }

  /* A refusal is not a throw, and the difference decides what happens next.

     The executor declines a confined path by *returning* a structured
     refusal rather than raising: nothing was attempted, so there is no
     crash to report and no half-finished work. But a returned refusal used
     to flow on into verification, which failed, which sent the pipeline
     looking for something to roll back — and there was nothing, because no
     write ever happened.

     The result was `rollback_failed` for a step that had not touched the
     disk. That is the worst possible report: it declares the workspace
     unknown when it is known to be untouched, and it is the one status
     that halts the whole run. A refusal has to be recognised as a refusal
     here, or the loop panics over a write it correctly declined to make. */
  if (isRefusal(executionOutput)) {
    const entry = ledger.append({
      action: step.action,
      payload: {
        stepId: step.id,
        outcome: "execution_refused",
        reason: executionOutput.error ?? executionOutput.failure.reason,
        kind: executionOutput.failure.kind,
        proposedPayload: step.payload,
      },
      verifier_result: "failed",
    });
    return {
      status: "execution_refused",
      stepId: step.id,
      action: step.action,
      executionOutput,
      authorityReason: executionOutput.error ?? executionOutput.failure.reason,
      ledgerEntry: entry,
    };
  }

  /* ── 3. Independent verification ────────────────────────────────────────
     The executor reported success above. That report is exactly what is not
     trusted: the verifier re-reads real state, because "the command exited
     0" and "the thing happened" are different claims. */
  const verification = await verifier.verify(step);

  if (verification.ok === false) {
    const entry = ledger.append({
      action: step.action,
      payload: {
        stepId: step.id,
        outcome: "verification_failed",
        expected: step.expected,
        evidence: verification.evidence,
        execution: executionOutput,
      },
      verifier_result: "failed",
    });

    /* The undo is itself a state change and gets its own entry, so a replay
       does not conclude "nothing happened" when a write was made and then
       removed. A rollback that throws is the worst case in the loop and is
       reported as its own status rather than folded into a failure. */
    try {
      await executor.rollback(step);
      ledger.append({
        action: `${step.action}.rollback`,
        payload: {
          stepId: step.id,
          outcome: "rolled_back",
          evidence: verification.evidence,
        },
        verifier_result: "success",
      });
      return {
        status: "verification_failed",
        stepId: step.id,
        action: step.action,
        executionOutput,
        verificationEvidence: verification.evidence,
        ledgerEntry: entry,
      };
    } catch (error) {
      const failure = ledger.append({
        action: `${step.action}.rollback`,
        payload: {
          stepId: step.id,
          outcome: "rollback_failed",
          error: message(error),
          workspaceState: "unknown",
        },
        verifier_result: "failed",
      });
      return {
        status: "rollback_failed",
        stepId: step.id,
        action: step.action,
        executionOutput,
        verificationEvidence: verification.evidence,
        ledgerEntry: entry,
        sealError: `rollback failed: ${message(error)} (see ${failure.current_hash.slice(0, 12)})`,
      };
    }
  }

  /* ── 4. Seal ────────────────────────────────────────────────────────────
     Only now, with execution output and verification evidence together, is
     the record written. */
  let entry: LedgerEntry;
  try {
    entry = ledger.append({
      action: step.action,
      payload: {
        stepId: step.id,
        outcome: "verified",
        expected: step.expected,
        execution: executionOutput,
        evidence: verification.evidence,
      },
      verifier_result: "success",
    });
  } catch (error) {
    /* The work happened, the verifier confirmed it, and the record of that
       could not be written. That combination has no honest success: the
       workspace holds a change nobody can prove was made or approved, and
       returning authorized_and_verified would be reporting a certainty this
       step does not have. The undo is deliberately NOT released — a caller
       that wants the workspace back can still get it, and the host is told
       this plainly rather than left to infer it from a missing file. */
    return {
      status: "record_failed",
      stepId: step.id,
      action: step.action,
      executionOutput,
      verificationEvidence: verification.evidence,
      sealError: message(error),
    };
  }

  /* Released only after the entry is durably recorded. The undo exists to
     make an unrecorded change recoverable; spending it before the record
     exists destroys the only proof that the change was ever made. */
  executor.commit?.(step);

  return {
    status: "authorized_and_verified",
    stepId: step.id,
    action: step.action,
    executionOutput,
    verificationEvidence: verification.evidence,
    ledgerEntry: entry,
  };
}

export type { LedgerEntry };
