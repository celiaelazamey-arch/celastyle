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
  run(action: string, payload: unknown): Promise<unknown>;
  /** Undo a completed run. May itself fail; that is not exceptional. */
  rollback(step: ProposedStep): Promise<void>;
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
  | "verification_failed"
  /** Verification failed AND the undo failed. The workspace is now unknown. */
  | "rollback_failed";

export type StepResult = {
  status: StepStatus;
  stepId: string;
  action: string;
  /** Present when the authority refused, and hashed into the ledger. */
  authorityReason?: string;
  executionOutput?: unknown;
  verificationEvidence?: unknown;
  /** Every outcome is recorded, so this is always present. */
  ledgerEntry: LedgerEntry;
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
    executionOutput = await executor.run(step.action, step.payload);
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
  const entry = ledger.append({
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
