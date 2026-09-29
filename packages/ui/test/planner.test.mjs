/**
 * Planner and Policy Engine — the top of the loop, and the part with the
 * least power.
 *
 * The authority judges one step at a time, so anything whose risk only
 * exists across steps is invisible to it by construction. These tests are
 * about that gap: twenty individually legal reads that together are
 * reconnaissance, six skills converging on one file, a high-risk goal
 * assembled entirely from steps that declare themselves low.
 *
 * The other half is replanning, and the assertions there are mostly about
 * what did NOT happen — no replan on an unrecorded change, a bounded number
 * of rounds, and a proposal identical to the failed one refused rather than
 * retried.
 */
import { buildPlan, orderPlan, runPlan, replan, readFailure, isReplannable } from "../.test-build-workspace/planner.js";
import { evaluatePlan, depthOf, DEFAULT_LIMITS } from "../.test-build-workspace/policy-engine.js";
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

const W = "/srv/workspace";

const skill = (over = {}) => ({
  name: "note-taker",
  risk_level: "low",
  allowed_tools: ["write_file", "read_file"],
  allowed_directories: [W],
  ...over,
});

const step = (id, over = {}) => ({
  id,
  action: "write_file",
  skill: skill(),
  payload: { path: `${W}/${id}.md`, content: "x" },
  expected: `${W}/${id}.md exists`,
  dependsOn: [],
  ...over,
});

const read = (id, dir, over = {}) =>
  step(id, { action: "read_file", payload: { path: `${dir}/f.txt` }, ...over });

// ── ordering: the DAG is the plan, or it is decoration ─────────────────────
console.log("\n\x1b[1mordering\x1b[0m");

{
  // Declared in the wrong order on purpose. If the runner ignored the graph
  // it would write the summary before collecting the data.
  const shuffled = [
    step("summary", { dependsOn: ["collect"] }),
    step("collect", { dependsOn: ["fetch"] }),
    step("fetch"),
  ];
  const ordered = orderPlan(shuffled);
  check(
    "a dependency is ordered before its dependent",
    ordered.findIndex((s) => s.id === "fetch") <
      ordered.findIndex((s) => s.id === "collect") &&
      ordered.findIndex((s) => s.id === "collect") <
        ordered.findIndex((s) => s.id === "summary"),
    ordered.map((s) => s.id).join(","),
  );
  check("and every step survives ordering", ordered.length === 3);
  check("no step is duplicated", new Set(ordered.map((s) => s.id)).size === 3);
}

{
  const flat = [step("c"), step("a"), step("b")];
  check(
    "independent steps keep their declared order",
    orderPlan(flat).map((s) => s.id).join(",") === "c,a,b",
    orderPlan(flat).map((s) => s.id).join(","),
  );
}

{
  // A cycle cannot be ordered. It must not hang, and it must not silently
  // drop a step — the caller needs to see everything it proposed.
  const cyclic = [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })];
  const ordered = orderPlan(cyclic);
  check("a cyclic plan still returns every step", ordered.length === 2);
  check("and does not hang", Array.isArray(ordered));
}

{
  const plan = { goal: "g", goalRisk: "low", steps: [step("a", { dependsOn: ["b"] }), step("b")], attempt: 0 };
  check("depth counts the longest chain", depthOf(plan) === 1, String(depthOf(plan)));
  check("a flat plan has depth zero", depthOf({ ...plan, steps: [step("a"), step("b")] }) === 0);
  const deep = { ...plan, steps: [step("a"), step("b", { dependsOn: ["a"] }), step("c", { dependsOn: ["b"] })] };
  check("a three-step chain is two deep", depthOf(deep) === 2, String(depthOf(deep)));
}

// ── structural refusals ────────────────────────────────────────────────────
console.log("\n\x1b[1mstructure: a malformed plan is refused before it runs\x1b[0m");

{
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a")] });
  check("a well-formed plan is accepted", built.ok === true, JSON.stringify(built));

  const empty = buildPlan({ goal: "g", goalRisk: "low", steps: [] });
  check("an empty plan is refused", empty.ok === false);
  check("with a specific reason", empty.ok === false && empty.verdict.code === "empty_plan");
}

{
  const big = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: Array.from({ length: 40 }, (_, i) => step(`s${i}`)),
  });
  check("an oversized plan is refused", big.ok === false);
  check("as too large", big.ok === false && big.verdict.code === "plan_too_large");
  check("and the bound is named", big.ok === false && /40/.test(big.verdict.reason), big.verdict?.reason);
}

{
  // The depth bound is a plan-level guard, not a per-step one: every step
  // is individually fine and the plan as a whole is not.
  const chain = Array.from({ length: 12 }, (_, i) => step(`s${i}`, { dependsOn: i > 0 ? [`s${i - 1}`] : [] }));
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: chain, limits: { ...DEFAULT_LIMITS, maxDepth: 5 } });
  check("a plan deeper than the bound is refused", built.ok === false);
  check("as too deep", built.ok === false && built.verdict.code === "plan_too_deep");
}

{
  const cyc = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })],
  });
  check("a dependency cycle is refused", cyc.ok === false);
  check("as a cycle", cyc.ok === false && cyc.verdict.code === "dependency_cycle");
  check("and the cycle is named", cyc.ok === false && /a.*b.*a/.test(cyc.verdict.reason), cyc.verdict?.reason);
}

{
  check("a missing dependency is refused",
    buildPlan({ goal: "g", goalRisk: "low", steps: [step("a", { dependsOn: ["ghost"] })] }).ok === false);
  const self = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a", { dependsOn: ["a"] })] });
  check("a self-dependency is refused", self.ok === false && self.verdict.code === "self_dependency");
  const dup = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a"), step("a")] });
  check("two steps with one id are refused", dup.ok === false && dup.verdict.code === "duplicate_step_id");
}

{
  // Defence in depth: the authority refuses these anyway, but a planner that
  // emits them is a planner bug and should be diagnosed as one.
  const internal = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a", { action: "__restore" })] });
  check("a plan proposing an internal action is refused", internal.ok === false);
  check("as a reserved action", internal.ok === false && internal.verdict.code === "reserved_action");
}

{
  // Same fail-secure posture the authority already uses for missing metadata:
  // a goal with no declared risk cannot be weighed against anything.
  const noRisk = buildPlan({ goal: "g", steps: [step("a")] });
  check("a goal with no declared risk is refused", noRisk.ok === false);
  check("as unknown goal risk", noRisk.ok === false && noRisk.verdict.code === "goal_risk_unknown");

  const badStep = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a", { skill: skill({ risk_level: "spicy" }) })] });
  check("a step with an undeclared risk is refused", badStep.ok === false);
  check("as undeclared risk", badStep.ok === false && badStep.verdict.code === "undeclared_risk");
}

// ── composite risk: the signals a per-step gate cannot see ────────────────
console.log("\n\x1b[1mcomposite risk: legal steps, dangerous plan\x1b[0m");

{
  // The case the authority structurally cannot catch. Every read is inside a
  // directory the skill was always allowed to read, so every read is
  // permitted. The aggregate is reconnaissance.
  const scan = Array.from({ length: 8 }, (_, i) =>
    read(`scan${i}`, `/srv/data${i}`, { skill: skill({ allowed_directories: ["/srv"] }) }),
  );
  const built = buildPlan({ goal: "survey the estate", goalRisk: "low", steps: scan });
  check("a plan reading eight directories is refused", built.ok === false, JSON.stringify(built.ok));
  check("as enumeration breadth", built.ok === false && built.verdict.code === "enumeration_breadth");
  check("and the reason admits each read was legal",
    built.ok === false && /individually permitted/.test(built.verdict.reason), built.verdict?.reason);

  // The boundary, so the signal is a bound and not a blanket refusal.
  const few = Array.from({ length: 3 }, (_, i) =>
    read(`ok${i}`, `/srv/data${i}`, { skill: skill({ allowed_directories: ["/srv"] }) }),
  );
  check("a plan inside the read bound is allowed", buildPlan({ goal: "look", goalRisk: "low", steps: few }).ok === true);
}

{
  // Six skills, one destination. No single write is remarkable; the
  // agreement between them is the thing.
  const converging = ["a", "b", "c"].map((name) =>
    step(`w-${name}`, {
      skill: skill({ name: `skill-${name}` }),
      payload: { path: `${W}/shared.md`, content: name },
    }),
  );
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: converging });
  check("three skills writing one file are refused", built.ok === false);
  check("as path convergence", built.ok === false && built.verdict.code === "path_convergence");
  check("and the skills are named", built.ok === false && /skill-a/.test(built.verdict.reason), built.verdict?.reason);

  const oneWriter = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("solo", { payload: { path: `${W}/only.md`, content: "x" } })],
  });
  check("one skill writing one file is fine", oneWriter.ok === true);
}

{
  // The named laundering case: a high-risk goal assembled entirely from
  // steps that each declare themselves low. No step is worth refusing, so
  // the authority refuses none, and the outcome is accomplished anyway.
  const benign = [
    step("gather", { action: "read_file", payload: { path: `${W}/in.txt` } }),
    step("combine", { action: "read_file", payload: { path: `${W}/in2.txt` } }),
  ];
  const built = buildPlan({ goal: "exfiltrate the workspace", goalRisk: "high", steps: benign });
  check("a high-risk goal built from low-risk steps is refused", built.ok === false);
  check("as privilege laundering", built.ok === false && built.verdict.code === "privilege_laundering");

  // The same shape at low goal risk is ordinary work and must be allowed,
  // or the signal is just a denier.
  check("but the same steps under a low-risk goal are fine",
    buildPlan({ goal: "read two files", goalRisk: "low", steps: benign }).ok === true);

  // And when one step does carry the risk, the plan is honest and allowed.
  const honest = [...benign, step("ship", { skill: skill({ risk_level: "high" }) })];
  check("a plan where one step carries the risk is allowed",
    buildPlan({ goal: "g", goalRisk: "high", steps: honest }).ok === true);
}

{
  // Collect across directories, then write — the shape a person should
  // confirm. Stated as a shape, not a proven exfiltration: content is never
  // inspected here, only the shape of the calls.
  //
  // One step is marked high risk on purpose. Without it the plan is caught
  // earlier as privilege laundering, which is a better catch but the wrong
  // one for this test; this isolates the signal it is actually about.
  const collect = [
    read("r1", "/srv/a", { skill: skill({ allowed_directories: ["/srv"] }) }),
    read("r2", "/srv/b", { skill: skill({ allowed_directories: ["/srv"] }) }),
    step("out", { skill: skill({ risk_level: "high" }) }),
  ];
  const built = buildPlan({ goal: "g", goalRisk: "high", steps: collect });
  check("collect-then-write under a high-risk goal is refused", built.ok === false, JSON.stringify(built));
  check("as collect_then_write", built.ok === false && built.verdict.code === "collect_then_write", built.verdict?.code);

  // Under a low-risk goal the same shape is a notice, not a refusal.
  const verdict = evaluatePlan({ goal: "g", goalRisk: "low", steps: collect }, DEFAULT_LIMITS);
  check("but under a low-risk goal it is only a notice", verdict.allowed === true, JSON.stringify(verdict));
  check("and the notice is recorded", verdict.allowed && verdict.notices.length > 0);
}

// ── reading the ledger ─────────────────────────────────────────────────────
console.log("\n\x1b[1mreading the ledger\x1b[0m");

{
  const ledger = new EventLedger();
  ledger.append({ action: "write_file", payload: { stepId: "s1", outcome: "verified" }, verifier_result: "success" });
  ledger.append({
    action: "write_file",
    payload: { stepId: "s2", outcome: "denied", reasonCode: "path_not_allowed", reason: "outside the sandbox" },
    verifier_result: "failed",
  });

  const signal = readFailure(ledger, "s2");
  check("a failure signal is recovered from the ledger", signal !== null);
  check("with its reason code", signal?.code === "path_not_allowed", signal?.code);
  check("and its reason", signal?.reason === "outside the sandbox", signal?.reason);
  check("and the entry it came from", typeof signal?.entryId === "string");
  check("a step with no entry yields nothing", readFailure(ledger, "ghost") === null);

  // The ledger is read, never written. A planner that appended its own
  // account of a failure would create a second, unverified one.
  const before = ledger.length;
  readFailure(ledger, "s2");
  check("reading a signal does not append to the ledger", ledger.length === before, `${ledger.length}`);
}

// ── what may be planned around ─────────────────────────────────────────────
console.log("\n\x1b[1mwhich failures may be replanned\x1b[0m");

{
  check("a denial may be replanned", isReplannable("denied"));
  check("an execution failure may be replanned", isReplannable("execution_failed"));
  check("a verification failure may be replanned", isReplannable("verification_failed"));

  // The two that mean the workspace cannot be described. Re-planning on top
  // of either would add a second untracked change and spend the only handle
  // on the first.
  check("record_failed may NOT be replanned", isReplannable("record_failed") === false);
  check("rollback_failed may NOT be replanned", isReplannable("rollback_failed") === false);
  check("success is not a failure at all", isReplannable("authorized_and_verified") === false);
}

// ── running a plan ─────────────────────────────────────────────────────────
console.log("\n\x1b[1mrunning\x1b[0m");

/** Executor and verifier that record what ran, in order. */
function harness(impl = {}) {
  const ran = [];
  return {
    ran,
    executor: {
      async run(action) {
        ran.push(action);
        if (impl.runThrows) throw new Error(impl.runThrows);
        return { ok: true };
      },
      async rollback() {},
    },
    verifier: {
      async verify() {
        ran.push("verify");
        return { ok: impl.verifyFails ? false : true, evidence: { checked: true } };
      },
    },
  };
}

{
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a"), step("b", { dependsOn: ["a"] })] });
  const h = harness();
  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
  });

  check("a plan that works completes", outcome.status === "completed", outcome.status);
  check("both steps ran", outcome.completed.length === 2, JSON.stringify(outcome.completed));
  check("and each was executed then verified", h.ran.join(",") === "write_file,verify,write_file,verify", h.ran.join(","));
}

{
  // The graph is only real if it is obeyed at run time.
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } }), step("b", { dependsOn: ["a"] })],
  });
  const h = harness();
  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
  });

  check("a refused step fails the run", outcome.status === "denied", outcome.status);
  check("its dependent is never executed", h.ran.filter((r) => r === "write_file").length === 0, h.ran.join(","));
  check("and the dependent is reported as not attempted",
    outcome.failures.some((f) => f.stepId === "b" && /not attempted/.test(f.result.authorityReason ?? "")));
  check("and it is not in the completed list", !outcome.completed.includes("b"));
}

{
  // A rejected plan must cost nothing — no step runs at all. The plan is
  // assembled and checked here rather than through buildPlan, because
  // buildPlan correctly refuses to hand back a plan it will not accept, and
  // the case under test is what runPlan does when given one anyway.
  const oversized = { goal: "g", goalRisk: "low", steps: [step("a")], attempt: 0 };
  const h = harness();
  const ledger = new EventLedger();
  const outcome = await runPlan(oversized, {
    executor: h.executor,
    verifier: h.verifier,
    ledger,
    approve: () => true,
    limits: { ...DEFAULT_LIMITS, maxSteps: 0 },
  });

  check("a refused plan never runs", outcome.status === "rejected", outcome.status);
  check("nothing was executed", h.ran.length === 0, h.ran.join(","));
  check("and nothing reached the ledger", ledger.length === 0, String(ledger.length));
  check("and the refusal explains itself", /refused before it ran/.test(outcome.reason ?? ""));
}

// ── replanning ────────────────────────────────────────────────────────────
console.log("\n\x1b[1mreplanning\x1b[0m");

{
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })],
  });
  const h = harness();
  const ledger = new EventLedger();
  let askedAbout = null;

  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger,
    approve: () => true,
    replan: (ctx) => {
      askedAbout = ctx;
      return { steps: [step("a-safe", { payload: { path: `${W}/safe.md`, content: "x" } })] };
    },
  });

  check("a denied step leads to a replan", outcome.replans === 1, String(outcome.replans));
  check("the strategy is asked with the failure", askedAbout?.failure?.result?.status === "denied");
  check("and with the reason read back from the ledger",
    askedAbout?.signal?.code === "path_not_allowed", JSON.stringify(askedAbout?.signal));
  check("and with the entry id it learned from", typeof askedAbout?.signal?.entryId === "string");
  check("the alternative then runs and succeeds", outcome.status === "completed", outcome.status);
  check("and its step is what completed", outcome.completed.includes("a-safe"), JSON.stringify(outcome.completed));

  // History is append-only. The denial stays in the ledger next to the
  // success that followed it; nothing is rewritten to make the retry tidy.
  const outcomes = ledger.all().map((e) => e.payload?.outcome);
  check("the ledger holds the denial AND the success",
    outcomes.includes("denied") && outcomes.includes("verified"), JSON.stringify(outcomes));
  check("and the denial is still verifiable", ledger.verify().ok === true);
}

{
  // The bound that actually stops the loop. Plan size does not: a plan of a
  // handful of steps re-formed forever runs forever without this.
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })],
  });
  const h = harness();
  let rounds = 0;

  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
    replan: () => {
      rounds += 1;
      // A genuinely different plan each time, so the no-op guard cannot be
      // what stops it — only the bound can.
      return { steps: [step(`try-${rounds}`, { payload: { path: "/etc/passwd", content: "x" } })] };
    },
    limits: { ...DEFAULT_LIMITS, maxReplans: 2 },
  });

  check("replanning stops at the bound", rounds === 2, `${rounds} rounds`);
  check("the run ends rather than continuing", outcome.status === "denied", outcome.status);
  check("and says it was the bound", /bound of 2/.test(outcome.reason ?? ""), outcome.reason);
  check("the number of replans is reported", outcome.replans === 2, String(outcome.replans));
}

{
  // A strategy that returns the same plan will fail the same way. Catching
  // the no-op turns an unbounded loop into a bounded number of rounds.
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })],
  });
  const h = harness();
  let calls = 0;

  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
    replan: () => {
      calls += 1;
      return { steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })] };
    },
  });

  check("a proposal identical to the failed plan is refused", calls === 1, `${calls} calls`);
  check("and the run ends there", outcome.status === "denied", outcome.status);
  check("saying why", /identical to the one that just failed/.test(outcome.reason ?? ""), outcome.reason);
}

{
  // An alternative that is itself dangerous does not get a second chance:
  // it goes back through the same policy engine.
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })],
  });
  const h = harness();

  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
    // Re-answers the same refusal with a plan that reads the whole disk.
    replan: () => ({
      steps: Array.from({ length: 9 }, (_, i) =>
        read(`s${i}`, `/srv/d${i}`, { skill: skill({ allowed_directories: ["/srv"] }) })),
    }),
  });

  check("a dangerous alternative is refused by the policy engine", outcome.replans === 0, String(outcome.replans));
  check("the run ends on it", outcome.status === "denied", outcome.status);
  check("and names the policy refusal", /refused:.*enumeration|alternative plan was refused/.test(outcome.reason ?? ""), outcome.reason);
}

{
  // No strategy at all is a stop, not an improvisation.
  const built = buildPlan({
    goal: "g",
    goalRisk: "low",
    steps: [step("a", { payload: { path: "/etc/passwd", content: "x" } })],
  });
  const h = harness();
  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger: new EventLedger(),
    approve: () => true,
  });

  check("with no strategy the run ends", outcome.status === "denied", outcome.status);
  check("saying there was no one to ask", /no replanning strategy/.test(outcome.reason ?? ""), outcome.reason);
  check("and nothing was replanned", outcome.replans === 0);
}

{
  // The one that matters most. A verified change with no record of it is not
  // something to plan around.
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a")] });
  const h = harness();
  let asked = false;

  const onDisk = [];
  let failing = true;
  const ledger = new EventLedger([], {
    write(line) {
      if (failing) throw new Error("ENOSPC");
      onDisk.push(JSON.parse(line));
    },
  });

  const outcome = await runPlan(built.plan, {
    executor: h.executor,
    verifier: h.verifier,
    ledger,
    approve: () => true,
    replan: () => {
      asked = true;
      return { steps: [step("b")] };
    },
  });

  check("an unrecorded change halts the run", outcome.status === "halted", outcome.status);
  check("no replan was even attempted", asked === false);
  check("the reason names the unknown state", /cannot be described/.test(outcome.reason ?? ""), outcome.reason);
  check("and the ledger holds no phantom", ledger.length === 0, String(ledger.length));
}

// ── replan() called directly ───────────────────────────────────────────────
console.log("\n\x1b[1mreplan() in isolation\x1b[0m");

{
  const built = buildPlan({ goal: "g", goalRisk: "low", steps: [step("a")] });
  const failure = {
    stepId: "a",
    result: { status: "denied", stepId: "a", action: "write_file", authorityReason: "outside" },
  };

  const noStrategy = replan({ plan: built.plan, failure, signal: null, propose: undefined });
  check("no strategy is a stop", noStrategy.ok === false);
  check("named as such", noStrategy.ok === false && noStrategy.stop === "no_proposer");

  const declined = replan({ plan: built.plan, failure, signal: null, propose: () => null });
  check("a strategy that declines is a stop", declined.ok === false && declined.stop === "no_proposer");

  const atBound = replan({
    plan: { ...built.plan, attempt: 3 },
    failure,
    signal: null,
    propose: () => ({ steps: [step("z")] }),
    limits: { ...DEFAULT_LIMITS, maxReplans: 3 },
  });
  check("the bound is enforced", atBound.ok === false && atBound.stop === "exhausted");

  const changed = replan({
    plan: built.plan,
    failure,
    signal: { outcome: "denied", entryId: "evt-1" },
    propose: () => ({ steps: [step("z")] }),
  });
  check("a genuinely different plan is accepted", changed.ok === true);
  check("and the new plan records what it was based on",
    changed.ok === true && changed.plan.basedOn?.entryId === "evt-1", JSON.stringify(changed.plan?.basedOn));
  check("and counts the attempt", changed.ok === true && changed.plan.attempt === 1);
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
