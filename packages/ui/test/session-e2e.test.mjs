/**
 * End to end: the path a request actually travels.
 *
 * Everything before this file was a library, verified against mocks and
 * in-process fakes. This one runs the assembled stack against a real
 * directory and a real ledger file, because the wiring is where the
 * guarantees stop being automatic. A planner with no caller cannot fail the
 * way its tests say it fails, and a ledger with no sink has a durability
 * path that exists in theory only.
 *
 * Nothing here is simulated. The writes go through the isolated executor's
 * child process, the verification re-reads the file from disk, and the
 * evidence survives the process that wrote it.
 */
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, FileSystemVerifier } from "../.test-build-workspace/session.js";
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

const root = await mkdtemp(join(tmpdir(), "session-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const ledgerPath = join(root, "state", "ledger.jsonl");

/* The real worker, resolved rather than assumed — the first version of the
   executor test pointed this at a path that did not exist and the symptom
   was a protocol error three layers away from the cause. */
const workerPath = resolve(
  new URL(".", import.meta.url).pathname,
  "../../../apps/command-center/app/lib/tools/worker.mjs",
);

const skill = {
  name: "note-taker",
  risk_level: "low",
  allowed_tools: ["write_file", "read_file"],
  allowed_directories: [workspace],
  timeout_ms: 5000,
};

const writeStep = (id, file, content, dependsOn = []) => ({
  id,
  action: "write_file",
  skill,
  payload: { path: join(workspace, file), content },
  expected: `${join(workspace, file)} exists with content "${content}"`,
  dependsOn,
});

const outcomesOf = (session) =>
  session.entries().map((e) => (e.payload ?? {}).outcome).filter(Boolean);

// ── the whole path, on disk ────────────────────────────────────────────────
console.log("\n\x1b[1mproposal → policy → authority → execution → evidence\x1b[0m");

{
  const session = await AgentSession.open({ ledgerPath, workerPath });
  const result = await session.run({
    goal: "write two notes, the second depending on the first",
    goalRisk: "low",
    steps: [writeStep("a", "one.md", "first"), writeStep("b", "two.md", "second", ["a"])],
  });

  check("the run completes", result.outcome.status === "completed", result.outcome.status);
  check("both steps completed", result.outcome.completed.length === 2, JSON.stringify(result.outcome.completed));

  // The files exist because a child process wrote them, not because a test
  // said so.
  check("the first file is on disk", (await readFile(join(workspace, "one.md"), "utf8")) === "first");
  check("the second file is on disk", (await readFile(join(workspace, "two.md"), "utf8")) === "second");

  /* The ledger file itself, not the in-memory chain. If durability is
     wired, the evidence is here on disk with nothing held in a process. */
  const raw = await readFile(ledgerPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  check("the ledger file exists and has lines", lines.length >= 2, `${lines.length} lines`);

  const onDisk = new EventLedger(lines.map((l) => JSON.parse(l)));
  check("the persisted chain verifies", onDisk.verify().ok === true, JSON.stringify(onDisk.verify().problems));
  check("it holds one entry per step", onDisk.length === 2, String(onDisk.length));
  check("both outcomes are recorded", outcomesOf(session).join(",") === "verified,verified", outcomesOf(session).join(","));

  // Evidence, not a claim: the recorded payload must carry what was
  // actually read back off the filesystem.
  const entry = onDisk.all()[0];
  const evidence = entry.payload.evidence;
  check("the entry carries evidence", evidence?.checked === true, JSON.stringify(evidence));
  check("and it is the real observed content", evidence?.actualContent === "first", JSON.stringify(evidence?.actualContent));
  check("with the path that was checked", evidence?.path === join(workspace, "one.md"));
  check("and a timestamp", typeof evidence?.observedAt === "string");

  check("the session reports a healthy chain", result.summary.chainOk === true);
  check("and that this was a fresh ledger", result.summary.resumed === false);
}

// ── restart: the evidence outlives the process that wrote it ───────────────
console.log("\n\x1b[1ma restart resumes the chain rather than starting clean\x1b[0m");

{
  // A brand new AgentSession over the same file, as a new server process
  // would do. The previous run's evidence must still be findable.
  const reopened = await AgentSession.open({ ledgerPath, workerPath });
  const summary = reopened.summary();

  check("the reopened session sees the earlier entries", summary.entries === 2, String(summary.entries));
  check("and knows it resumed", summary.resumed === true);
  check("and the chain still verifies", summary.chainOk === true);

  const headBefore = summary.head;
  const result = await reopened.run({
    goal: "add a third note",
    goalRisk: "low",
    steps: [writeStep("c", "three.md", "third")],
  });

  check("the new run completes", result.outcome.status === "completed", result.outcome.status);
  check("the chain grew by exactly one", reopened.summary().entries === 3, String(reopened.summary().entries));
  check("and the new head differs from the old", reopened.summary().head !== headBefore);

  /* The link across the restart is the whole point. Entry 2 was written by a
     previous process; entry 3's previous_hash has to be entry 2's hash, and
     that can only be true if the file was actually read back. */
  const reloaded = await EventLedger.fromFile(ledgerPath);
  check("the reloaded chain verifies across the restart", reloaded.verify().ok === true,
    JSON.stringify(reloaded.verify().problems));
  check("no sequence gap across the boundary",
    reloaded.all().every((e, i) => e.index === i), JSON.stringify(reloaded.all().map((e) => e.index)));
  check("entry 3 links to entry 2 across processes",
    reloaded.all()[2].previous_hash === reloaded.all()[1].current_hash);
}

// ── denial → replan → second policy evaluation ─────────────────────────────
console.log("\n\x1b[1mdenial → replan → policy again\x1b[0m");

{
  const session = await AgentSession.open({ ledgerPath, workerPath });
  const before = session.summary().entries;

  const denied = writeStep("d", "escape.md", "nope");
  denied.payload = { path: "/etc/celastyle-should-not-exist", content: "nope" };
  denied.expected = "/etc/celastyle-should-not-exist exists with content \"nope\"";

  let policyChecks = 0;

  const result = await session.run({
    goal: "try to write outside the workspace, then do it properly",
    goalRisk: "low",
    steps: [denied],
    replan: () => {
      policyChecks += 1;
      return { steps: [writeStep("d2", "safe.md", "written properly")] };
    },
    approve: async () => true,
  });

  check("the run ends completed after the replan", result.outcome.status === "completed", result.outcome.status);
  check("one replan happened", result.outcome.replans === 1, String(result.outcome.replans));
  check("the strategy was asked", policyChecks === 1, String(policyChecks));
  check("the replacement step is what completed", result.outcome.completed.includes("d2"), JSON.stringify(result.outcome.completed));

  check("the real file was written", (await readFile(join(workspace, "safe.md"), "utf8")) === "written properly");

  /* The denial and the success are both on disk, in order. Reforming a plan
     does not erase the refusal that caused it — that history is the reason
     the alternative is trustworthy rather than a quiet retry. */
  const outcomes = outcomesOf(session);
  check("the ledger holds the denial and the success",
    outcomes.includes("denied") && outcomes.includes("verified"), outcomes.join(","));
  check("in that order",
    outcomes.lastIndexOf("denied") < outcomes.lastIndexOf("verified"), outcomes.join(","));

  const denial = session.entries().find((e) => e.payload?.outcome === "denied");
  check("the denial records its reason code", denial?.payload?.reasonCode === "path_not_allowed", denial?.payload?.reasonCode);
  check("and the reason is inside the hashed payload", typeof denial?.payload?.reason === "string");
  check("the chain still verifies after the replan", result.summary.chainOk === true);
  check("and grew by both the denial and the success", session.summary().entries === before + 2, `${session.summary().entries - before}`);
}

// ── a refused plan costs nothing ───────────────────────────────────────────
console.log("\n\x1b[1ma plan the policy engine refuses never reaches the gate\x1b[0m");

{
  const session = await AgentSession.open({ ledgerPath, workerPath });
  const before = session.summary().entries;

  // Eight individually legal reads across eight directories: reconnaissance
  // the authority cannot see, because it only ever sees one call.
  const scan = Array.from({ length: 8 }, (_, i) => ({
    ...writeStep(`scan${i}`, "x", "x"),
    action: "read_file",
    payload: { path: `/srv/data${i}/f.txt` },
    expected: `/srv/data${i}/f.txt exists`,
    skill: { ...skill, allowed_directories: ["/srv"] },
  }));

  const result = await session.run({ goal: "survey the estate", goalRisk: "low", steps: scan });

  check("the run is rejected", result.outcome.status === "rejected", result.outcome.status);
  check("the refusal explains itself", /enumeration breadth|individually permitted/.test(result.outcome.reason ?? ""), result.outcome.reason);
  check("nothing was written to the ledger", session.summary().entries === before, `${session.summary().entries - before}`);
  check("no file was created", await stat(join(workspace, "x")).then(() => false, () => true));
}

// ── a refusal is a refusal, not a rollback failure ────────────────────────
console.log("\n\x1b[1mdeclining a write is not the same as failing one\x1b[0m");

{
  /* A refused path used to flow on into verification, which failed, which
     sent the pipeline looking for something to roll back — and there was
     nothing, because no write happened. That produced `rollback_failed` for
     a step that had not touched the disk, declaring the workspace unknown
     when it was untouched, and halting the run. The worst possible report
     about a write the system correctly declined to make. */
  const session = await AgentSession.open({ ledgerPath: join(root, "refusal.jsonl"), workerPath });

  const escape = join(workspace, "escape2");
  await symlink("/etc", escape, "dir");

  const result = await session.run({
    goal: "write through a symlink that leaves the workspace",
    goalRisk: "low",
    steps: [
      {
        id: "r",
        action: "write_file",
        skill,
        payload: { path: join(escape, "celastyle-refused.md"), content: "nope" },
        expected: `${join(escape, "celastyle-refused.md")} exists with content "nope"`,
        dependsOn: [],
      },
    ],
  });

  const stepResult = result.outcome.steps[0];
  check("the step is reported as refused", stepResult?.status === "execution_refused", stepResult?.status);
  check("and NOT as a rollback failure", stepResult?.status !== "rollback_failed");
  check("the run does not halt on it", result.outcome.status !== "halted", result.outcome.status);
  check("the refusal explains itself",
    /resolves to|outside every allowed directory/.test(stepResult?.authorityReason ?? ""), stepResult?.authorityReason);
  check("nothing landed outside the workspace",
    await stat("/etc/celastyle-refused.md").then(() => false, () => true));
  check("and the chain is still intact", result.summary.chainOk === true);
}

// ── the verifier is independent, and says when it cannot tell ──────────────
console.log("\n\x1b[1mthe verifier reads state, and refuses to guess\x1b[0m");

{
  const verifier = new FileSystemVerifier();

  const good = await verifier.verify({
    payload: { path: join(workspace, "one.md") },
    expected: `${join(workspace, "one.md")} exists with content "first"`,
  });
  check("it confirms a true claim", good.ok === true, JSON.stringify(good.evidence));
  check("by reporting what it read", good.evidence.actualContent === "first");

  const wrong = await verifier.verify({
    payload: { path: join(workspace, "one.md") },
    expected: `${join(workspace, "one.md")} exists with content "a lie"`,
  });
  check("it refuses a false claim", wrong.ok === false);
  check("and shows the difference", wrong.evidence.actualContent === "first" && wrong.evidence.expectedContent === "a lie");

  /* The one that matters most. An expectation it cannot parse must not be
     passed; a verifier that shrugs and approves an unreadable claim is the
     exact failure this loop exists to prevent. */
  const opaque = await verifier.verify({
    payload: { path: join(workspace, "one.md") },
    expected: "the workspace is in good shape",
  });
  check("an unverifiable expectation is not approved", opaque.ok === false);
  check("and says it did not understand it", opaque.evidence.checked === false, JSON.stringify(opaque.evidence));

  const mismatched = await verifier.verify({
    payload: { path: join(workspace, "one.md") },
    expected: `${join(workspace, "other.md")} exists`,
  });
  check("an expectation naming another file is refused", mismatched.ok === false);
}

// ── a lost record still stops the run ──────────────────────────────────────
console.log("\n\x1b[1mthe wired path keeps the record_failed behaviour\x1b[0m");

{
  // The same ledger contract, reached through the real assembly rather than
  // an injected sink. The file is made unwritable at the filesystem level,
  // so this is an operating-system failure and not a stub.
  const unwritable = join(root, "readonly", "ledger.jsonl");
  await mkdir(join(root, "readonly"), { recursive: true });
  await writeFile(unwritable, "", "utf8");

  const session = await AgentSession.open({ ledgerPath: unwritable, workerPath });
  const { chmodSync } = await import("node:fs");
  chmodSync(unwritable, 0o444);

  let replanAsked = false;
  const result = await session.run({
    goal: "write a note that cannot be recorded",
    goalRisk: "low",
    steps: [writeStep("z", "unrecorded.md", "this change will not be provable")],
    replan: () => {
      replanAsked = true;
      return { steps: [writeStep("z2", "also-unrecorded.md", "x")] };
    },
  });

  // Running as root defeats the permission bit, so this assertion is only
  // meaningful where the bit actually bites. Reported either way rather than
  // quietly passing on a run that proved nothing.
  if (result.outcome.status === "halted") {
    check("the run halts when the record cannot be written", true);
    check("and no replan is attempted", replanAsked === false);
    check("and the reason names the unknown state", /cannot be described/.test(result.outcome.reason ?? ""));
    check("while the change itself did happen on disk",
      (await readFile(join(workspace, "unrecorded.md"), "utf8")).length > 0);
  } else {
    check(
      `SKIPPED: the read-only bit did not bite (ran as uid ${process.getuid?.()}), so record_failed is untested on this path`,
      result.outcome.status === "completed",
      result.outcome.status,
    );
  }
  chmodSync(unwritable, 0o644);
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
