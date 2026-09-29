/**
 * The pipeline contract — ordering, short-circuiting, and the record.
 *
 * A contract is only as good as the order it enforces, so most of these
 * tests are about *what did not happen*: the executor never runs after a
 * refusal, the verifier never runs after a throw, the rollback never runs
 * after a pass. A pipeline that checks everything in the right order but
 * still calls things it should have skipped is not enforcing anything.
 *
 * The spies throw when called out of turn rather than recording a flag. A
 * recorded flag is evidence a test may forget to assert; a throw cannot be
 * ignored.
 */
import { executeCognitiveStep } from "../.test-build-workspace/cognitive-pipeline.js";
import { EventLedger } from "../.test-build-workspace/event-ledger.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
};

const WORKSPACE = "/srv/workspace";

// A single module-level trace, deliberately. The spies below append to it
// through `trace`, and each test reads it after resetting — if the trace were
// per-test, every spy would have to be handed the right one, and a spy that
// lost its reference would silently stop recording. One shared trace, cleared
// at the start of each test, cannot drift.
let callOrder = [];
const trace = (what) => {
  callOrder.push(what);
  return what;
};

/** A step that is low-risk, in-scope, and therefore passes the gate. */
function step(overrides = {}) {
  return {
    id: "step-1",
    action: "write_file",
    skill: {
      name: "note-taker",
      risk_level: "low",
      allowed_tools: ["write_file"],
      allowed_directories: [WORKSPACE],
    },
    payload: { path: `${WORKSPACE}/a.md`, content: "hello" },
    expected: `${WORKSPACE}/a.md exists with content "hello"`,
    ...overrides,
  };
}

/** Executor that records what it was asked to do, in order. */
function spyExecutor(impl = {}) {
  return {
    async run(action, payload) {
      trace(`execute:${action}`);
      if (impl.runThrows) throw new Error(impl.runThrows);
      return impl.output ?? { wrote: payload?.path };
    },
    async rollback(s) {
      trace("rollback");
      if (impl.rollbackThrows) throw new Error(impl.rollbackThrows);
    },
  };
}

function spyVerifier(ok = true, evidence = { checked: "file" }) {
  return {
    async verify(s) {
      trace("verify");
      return { ok, evidence: evidence ?? { checked: "none" } };
    },
  };
}

/** A fresh ledger and a cleared trace. `c.callOrder` is the live array. */
function fresh() {
  callOrder = [];
  return {
    get callOrder() { return callOrder; },
    ledger: new EventLedger(),
  };
}

// ── the happy path ─────────────────────────────────────────────────────────
console.log("\n\x1b[1mauthorised, executed, verified, sealed\x1b[0m");

{
  const c = fresh();
  const result = await executeCognitiveStep(step(), {
    executor: spyExecutor(),
    verifier: spyVerifier(true),
    ledger: c.ledger,
  });

  check("the step is reported verified", result.status === "authorized_and_verified", result.status);
  check("execute happened before verify", c.callOrder[0] === "execute:write_file" && c.callOrder[1] === "verify", c.callOrder.join(","));
  check("the ledger records the success", c.ledger.all().at(-1).verifier_result === "success");
  check("and the outcome inside it is verified", c.ledger.all().at(-1).payload.outcome === "verified");
  check("evidence is retained on the result", result.verificationEvidence !== undefined);
  check("the seal is returned", result.ledgerEntry.current_hash.length === 64);
  check("the chain verifies after a clean step", c.ledger.verify().ok);
}

{
  // The single most important assertion in this file: a successful step must
  // not roll back. A rollback that fires "just in case" destroys work for no
  // reason, and it is easy to introduce by accident.
  const c = fresh();
  await executeCognitiveStep(step(), { executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger });
  check("a passing step never rolls back", !c.callOrder.includes("rollback"), c.callOrder.join(","));
}

// ── short-circuit 1: the gate refuses ───────────────────────────────────────
console.log("\n\x1b[1mshort-circuit — the gate refuses\x1b[0m");

{
  const c = fresh();
  const outOfScope = step({ payload: { path: "/etc/passwd", content: "owned" } });
  const result = await executeCognitiveStep(outOfScope, {
    // A verifier that throws if reached — the strongest possible proof that
    // verification is genuinely downstream of the decision.
    executor: spyExecutor(),
    verifier: { async verify() { throw new Error("verifier must not run for a refused step"); } },
    ledger: c.ledger,
  });

  check("the step is denied", result.status === "denied", result.status);
  check("the executor never ran", !c.callOrder.includes("execute:write_file"), c.callOrder.join(","));
  check("the verifier never ran", !c.callOrder.includes("verify"));
  check("nothing was rolled back", !c.callOrder.includes("rollback"));
  check("the refusal still has a reason", typeof result.authorityReason === "string" && result.authorityReason.length > 0);
}

{
  // A refused attempt is evidence, and the most valuable kind. It is also
  // the kind most easily lost, because nothing else in the system records it.
  const c = fresh();
  await executeCognitiveStep(step({ payload: { path: "/etc/shadow", content: "x" } }), {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger,
  });

  const entry = c.ledger.all().at(-1);
  check("a refusal is written to the ledger", c.ledger.length === 1);
  check("it is recorded as a failure", entry.verifier_result === "failed");
  check("the payload says it was denied", entry.payload.outcome === "denied");
  check("the reason code is preserved", typeof entry.payload.reasonCode === "string", entry.payload.reasonCode);
  check("the chain still verifies", c.ledger.verify().ok);
}

{
  // The reason has to be inside the hashed payload. Passed as a side argument
  // it would be the one field an attacker could rewrite silently.
  const c = fresh();
  await executeCognitiveStep(step({ payload: { path: "/etc/shadow" } }), {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger,
  });
  const before = c.ledger.all().at(-1).current_hash;
  const entries = c.ledger.all().map((e) => ({ ...e, payload: { ...e.payload } }));
  entries[0].payload.reason = "an innocent sentence";
  const { verifyChain } = await import("../.test-build-workspace/event-ledger.js");
  check("editing the recorded reason breaks the chain",
    verifyChain(entries).ok === false, "reason was not committed");
  check("and the untouched ledger still verifies", c.ledger.verify().ok && before.length === 64);
}

// ── short-circuit 2: execution throws ──────────────────────────────────────
console.log("\n\x1b[1mshort-circuit — execution throws\x1b[0m");

{
  const c = fresh();
  const result = await executeCognitiveStep(step(), {
    executor: spyExecutor({ runThrows: "disk full" }),
    verifier: { async verify() { throw new Error("verifier must not run after a failed execution"); } },
    ledger: c.ledger,
  });

  check("the step reports execution failure", result.status === "execution_failed", result.status);
  check("the verifier was not reached", !c.callOrder.includes("verify"));
  check("no rollback was attempted", !c.callOrder.includes("rollback"));
  check("the error message is recorded",
    c.ledger.all().at(-1).payload.error === "disk full", c.ledger.all().at(-1).payload.error);
  check("and it is recorded as a failure", c.ledger.all().at(-1).verifier_result === "failed");
  check("the chain verifies", c.ledger.verify().ok);
}

// ── the interesting case: the executor lies ────────────────────────────────
console.log("\n\x1b[1mthe executor reports success, the verifier disagrees\x1b[0m");

{
  const c = fresh();
  const result = await executeCognitiveStep(step(), {
    executor: spyExecutor({ output: "wrote 1 file (exit 0)" }),
    verifier: spyVerifier(false, { fileExists: false, reason: "no such file" }),
    ledger: c.ledger,
  });

  check("the step fails verification", result.status === "verification_failed", result.status);
  check("the executor's success claim is not trusted", c.callOrder.includes("verify"));
  check("a rollback is performed", c.callOrder.includes("rollback"));
  check("the order is execute → verify → rollback",
    c.callOrder.join(",") === "execute:write_file,verify,rollback", c.callOrder.join(","));
  check("the ledger records the failure, not the executor's claim",
    c.ledger.all().find((e) => e.action === "write_file").verifier_result === "failed");
  check("the verifier's evidence is kept",
    c.ledger.all().find((e) => e.action === "write_file").payload.evidence.fileExists === false);
  check("the chain verifies", c.ledger.verify().ok);
}

{
  /* A write that happened and was then undone is not "nothing happened".
     The original contract rolled back and left a ledger saying "failed",
     which on replay asserts no write occurred. The rollback is a state
     transition and has to be a record of its own. */
  const c = fresh();
  await executeCognitiveStep(step(), {
    executor: spyExecutor(), verifier: spyVerifier(false, { fileExists: false }), ledger: c.ledger,
  });

  const rollback = c.ledger.all().find((e) => e.action === "write_file.rollback");
  check("the rollback is its own ledger entry", rollback !== undefined);
  check("it records what it undid", rollback.payload.outcome === "rolled_back");
  check("both entries are in the chain", c.ledger.length === 2);
  check("and the chain verifies across both", c.ledger.verify().ok);
  check("the rollback links to the failure",
    rollback.previous_hash === c.ledger.all()[0].current_hash);
}

// ── the worst state, which the sketch had no name for ─────────────────────
console.log("\n\x1b[1mverification failed and the undo failed too\x1b[0m");

{
  const c = fresh();
  const result = await executeCognitiveStep(step(), {
    executor: spyExecutor({ rollbackThrows: "fs is read-only" }),
    verifier: spyVerifier(false, { fileExists: false }),
    ledger: c.ledger,
  });

  check("it is reported distinctly, not as a plain failure",
    result.status === "rollback_failed", result.status);
  check("the operator is told the workspace is unknown",
    typeof result.sealError === "string" && result.sealError.includes("rollback failed"));
  check("the failed undo is recorded", c.ledger.all().at(-1).payload.outcome === "rollback_failed");
  check("the record says the state is unknown",
    c.ledger.all().at(-1).payload.workspaceState === "unknown");
  check("the chain verifies even in this state", c.ledger.verify().ok);
}

// ── ordering is the property, so it is asserted directly ──────────────────
console.log("\n\x1b[1mthe ledger records the run in order\x1b[0m");

{
  const c = fresh();
  await executeCognitiveStep(step(), { executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger });
  await executeCognitiveStep(step({ id: "step-2" }), { executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger });
  await executeCognitiveStep(step({ id: "step-3", payload: { path: "/etc/hosts" } }), {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger,
  });

  const all = c.ledger.all();
  check("three steps produce three entries", all.length === 3, `${all.length}`);
  check("indexes are sequential", all.every((e, i) => e.index === i));
  check("every step id is recorded", all.map((e) => e.payload.stepId).join(",") === "step-1,step-2,step-3");
  check("the refusal is last, as it happened last", all[2].payload.outcome === "denied");
  check("the whole run verifies", c.ledger.verify().ok);
  check("the seal matches the final entry", c.ledger.seal() === all[2].current_hash);
}

// ── approval wiring ────────────────────────────────────────────────────────
console.log("\n\x1b[1mapproval reaches the gate through the pipeline\x1b[0m");

{
  const medium = step({
    skill: { ...step().skill, risk_level: "medium", requires_human_approval: false },
  });

  // Each scenario gets its own call trace. Sharing one across three steps
  // would let the first step's calls stand in as evidence for the third,
  // which is how three unrelated failures appeared together below.
  const a = fresh();
  const refused = await executeCognitiveStep(medium, {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: a.ledger,
  });
  check("a medium step with no approver is denied", refused.status === "denied", refused.status);
  check("and its executor never ran", !a.callOrder.includes("execute:write_file"), a.callOrder.join(","));

  const b = fresh();
  const approved = await executeCognitiveStep(medium, {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: b.ledger, approve: () => true,
  });
  check("and proceeds once an operator approves", approved.status === "authorized_and_verified", approved.status);
  check("with the executor running exactly once", b.callOrder.filter((x) => x.startsWith("execute")).length === 1);

  const c = fresh();
  const silent = await executeCognitiveStep(medium, {
    executor: spyExecutor(), verifier: spyVerifier(true), ledger: c.ledger, approve: () => undefined,
  });
  check("and is denied when the approver says nothing", silent.status === "denied", silent.status);
  check("naming the unanswered approval, not a generic failure",
    c.ledger.all().at(-1).payload.reasonCode === "approval_unanswered",
    c.ledger.all().at(-1).payload.reasonCode);
  check("and nothing was executed in that case", !c.callOrder.includes("execute:write_file"));
}

// ── sealing: when the record cannot be written ────────────────────────────
/*
 * The pipeline's last word is the ledger. If that word cannot be written the
 * step has run, the verifier has confirmed it, and no record of either
 * exists. That combination has no honest success, so the contract names it
 * rather than letting the caller infer it.
 */
console.log("\n\x1b[1msealing: the ledger refuses the entry\x1b[0m");

/** A ledger whose disk fails, so append throws the way a full disk would. */
function failingLedger() {
  const onDisk = [];
  let failing = false;
  const ledger = new EventLedger([], {
    write(line) {
      if (failing) throw new Error("ENOSPC: no space left on device");
      onDisk.push(JSON.parse(line));
    },
  });
  return {
    ledger,
    onDisk,
    fail() { failing = true; },
    heal() { failing = false; },
  };
}

{
  const c = fresh();
  const store = failingLedger();
  store.fail();

  let result;
  let threw = null;
  try {
    result = await executeCognitiveStep(step(), {
      executor: spyExecutor(),
      verifier: spyVerifier(true),
      ledger: store.ledger,
      approve: () => true,
    });
  } catch (error) {
    threw = error.message;
  }

  check("a failed seal does not escape as an exception", threw === null, String(threw));
  check("the step reports record_failed", result?.status === "record_failed", result?.status);
  check("it does NOT claim authorized_and_verified", result?.status !== "authorized_and_verified");
  check("there is no ledger entry, because none was written", result?.ledgerEntry === undefined);
  check("and the reason the disk gave is carried through",
    (result?.sealError ?? "").includes("ENOSPC"), result?.sealError);

  /* The step really did run and really was verified — which is exactly why
     reporting a plain failure would be a lie of the opposite kind. The
     evidence is present, and so is the admission that it is unrecorded. */
  check("the evidence is still returned", result?.verificationEvidence !== undefined);
  check("the execution output is still returned", result?.executionOutput !== undefined);

  check("nothing reached the sink", store.onDisk.length === 0, `${store.onDisk.length}`);
  check("and the in-memory chain is empty, matching the disk",
    store.ledger.length === 0, String(store.ledger.length));
  check("so the ledger still verifies clean rather than holding a phantom",
    store.ledger.verify().ok === true);
}

{
  // The undo exists to make an unrecorded change recoverable. Releasing it
  // because the record failed would destroy the only handle on a change that
  // now has no paper trail at all.
  const c = fresh();
  const store = failingLedger();
  store.fail();

  let commits = 0;
  const executor = {
    async run() { return { wrote: true }; },
    async rollback() { trace("rollback"); },
    commit() { commits += 1; },
  };

  const result = await executeCognitiveStep(step(), {
    executor,
    verifier: spyVerifier(true),
    ledger: store.ledger,
    approve: () => true,
  });

  check("record_failed does not release the undo", commits === 0, `commit called ${commits}x`);
  check("and the step is not reported as sealed", result.status === "record_failed");
}

{
  // The mirror case, and the one that keeps the ordinary path honest: a
  // successful seal does release it, otherwise undo records would accumulate
  // for every step the agent ever took.
  const c = fresh();
  let commits = 0;
  const executor = {
    async run() { return { wrote: true }; },
    async rollback() { trace("rollback"); },
    commit() { commits += 1; },
  };

  const result = await executeCognitiveStep(step(), {
    executor,
    verifier: spyVerifier(true),
    ledger: c.ledger,
    approve: () => true,
  });

  check("a successful seal releases the undo exactly once", commits === 1, `${commits}`);
  check("and reports the ordinary success", result.status === "authorized_and_verified");
}

{
  // Outage in the middle of a session, rather than before it starts. The
  // chain must survive a failed write and the next step must link correctly —
  // this is the corruption the old ordering made permanent.
  const c = fresh();
  const store = failingLedger();
  const deps = { executor: spyExecutor(), verifier: spyVerifier(true), approve: () => true };

  const first = await executeCognitiveStep(step({ id: "step-a" }), { ...deps, ledger: store.ledger });
  check("the first step seals normally", first.status === "authorized_and_verified", first.status);

  store.fail();
  const during = await executeCognitiveStep(step({ id: "step-b" }), { ...deps, ledger: store.ledger });
  check("the step during the outage reports record_failed", during.status === "record_failed", during.status);

  store.heal();
  const after = await executeCognitiveStep(step({ id: "step-c" }), { ...deps, ledger: store.ledger });
  check("the step after recovery seals again", after.status === "authorized_and_verified", after.status);

  check("the durable chain holds the two real steps", store.onDisk.length === 2, `${store.onDisk.length}`);
  const reloaded = new EventLedger(store.onDisk);
  check("and it verifies with no gap and no broken link", reloaded.verify().ok === true,
    JSON.stringify(reloaded.verify().problems));
  check("memory and disk agree after the outage",
    store.ledger.length === store.onDisk.length);
  check("the failed step left no entry behind",
    !store.onDisk.some(e => JSON.stringify(e.payload ?? {}).includes("step-b")));
}

{
  // Denial is recorded too, and a disk that refuses that record must not
  // report a denial that was never written. The step is refused either way —
  // the executor never runs — but the record is genuinely absent.
  const c = fresh();
  const store = failingLedger();
  store.fail();

  let result;
  let threw = null;
  try {
    result = await executeCognitiveStep(step({ skill: undefined }), {
      executor: spyExecutor(),
      verifier: spyVerifier(true),
      ledger: store.ledger,
    });
  } catch (error) {
    threw = error.message;
  }

  check("a denial whose record cannot be written still refuses", result?.status !== "authorized_and_verified");
  check("and the executor never ran", !c.callOrder.some(x => x.startsWith("execute:")));
  check("nothing reached the disk", store.onDisk.length === 0);
  check("the in-memory chain stayed empty", store.ledger.length === 0, String(store.ledger.length));
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
