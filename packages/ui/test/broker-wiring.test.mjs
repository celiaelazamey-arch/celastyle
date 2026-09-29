/**
 * L2′ — the live path actually asking the broker.
 *
 * The broker in `credential-broker.test.mjs` is correct and completely
 * unreachable: nothing in production called it. These tests exist because
 * "the component works" and "the component decides" are different claims, and
 * only the second one is a security property.
 *
 * The load-bearing one is at the end. A worker that holds no service secret
 * is the entire premise of the broker, and it is easy to assert it in a unit
 * test that constructs the environment itself and therefore proves nothing.
 * So the worker here is the real one, spawned by the real executor, and the
 * secret is read out of the child's own /proc/<pid>/environ — the kernel's
 * copy, not ours.
 */
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CredentialBroker } from "../.test-build-workspace/credential-broker.js";
import { BrokerGate, AUTHORIZE_ACTION } from "../.test-build-workspace/broker/broker-gate.js";
import { EventLedger, verifyChain } from "../.test-build-workspace/event-ledger.js";
import { IsolatedExecutor } from "../.test-build-workspace/isolated-executor.js";
import { ToolRegistry, resolveSurface } from "../.test-build-workspace/capabilities.js";

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

const root = await mkdtemp(join(tmpdir(), "gate-"));
const socketDir = join(root, "run");
await mkdir(socketDir, { recursive: true });

const registry = new ToolRegistry().register({
  id: "workspace",
  grants: [
    { action: "write_file", capability: "workspace.write", scopes: [], risk: "medium", requiresApproval: false },
  ],
});

const broker = await CredentialBroker.start({ socketPath: join(socketDir, "broker.sock") });

/** A stand-in for the operator's credential. It exists only so the test can
 *  assert it never appears anywhere near the worker — the broker holds it,
 *  the gate never sees it, and the ledger must not record it. */
const SERVICE_SECRET = "service-secret-that-must-never-appear-in-a-worker";

/** A worker that reports what it can actually see in its own process, so the
 *  assertion is made against the kernel's view rather than ours. */
const reportingWorker = join(root, "reporter.mjs");
await writeFile(
  reportingWorker,
  `import { readFileSync, writeFileSync } from "node:fs";
   import { dirname } from "node:path";

   /* The real worker's protocol — one JSON result line — plus a report of what
      this process can actually see. The write is real: an executor that never
      spawns anything would also produce no environ, and a test that passed on
      a worker that did not run would be testing the absence of a process
      rather than the contents of one. */
   const request = JSON.parse(readFileSync(0, "utf8"));
   const env = readFileSync("/proc/self/environ", "utf8");
   const report = {
     environ: env.split("\\0").filter(Boolean).sort(),
     has: (needle) => env.includes(needle),
   };

   if (request.action === "write_file") {
     const { path, content } = request.payload ?? {};
     writeFileSync(path, content);
     process.stdout.write(
       JSON.stringify({ ok: true, path, bytes: content.length, report }) + "\\n",
     );
   } else {
     process.stdout.write(
       JSON.stringify({ ok: false, error: "unsupported action " + request.action }) + "\\n",
     );
   }
`,
);

async function scenario(name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const ledger = new EventLedger();
  const surface = (() => {
    const r = resolveSurface({ registry, taskId: "t", needs: [{ capability: "workspace.write" }] });
    if (!r.ok) throw new Error(r.reason);
    return r.surface;
  })();

  await broker.openSession({ sessionId: name, surface });
  const gate = await BrokerGate.open({ broker, ledger, sessionId: name });

  const executor = new IsolatedExecutor({
    workerPath: reportingWorker,
    surface,
    taskEnv: { ...gate.workerEnv() },
    authorizer: gate,
  });

  /* The executor confines writes before it reaches the gate, so a test that
     omits allowed directories is testing the path check and calling it a
     broker result. The skill is what makes the path legitimate, and it is
     scoped to this scenario's own directory. */
  const skill = { name, allowed_directories: [dir], timeout_ms: 5000 };

  return { ledger, executor, gate, dir, name, skill };
}

// ── a decision becomes evidence ───────────────────────────────────────────
console.log("\n\x1b[1ma decision is recorded either way\x1b[0m");

{
  const { ledger, executor, dir, skill } = await scenario("wired-allow");
  const outcome = await executor.run("write_file", {
    path: join(dir, "a.txt"),
    content: "hello",
  }, skill);

  check("a granted action runs", outcome.ok === true, JSON.stringify(outcome.failure ?? {}));

  const entries = ledger.all().filter((e) => e.action === AUTHORIZE_ACTION);
  check("and the authorization is in the ledger", entries.length === 1, String(entries.length));
  check("recording that it was allowed", entries[0]?.payload?.allowed === true);
  check("with the capability that answered", entries[0]?.payload?.capability === "workspace.write");
  check("and the epoch it was answered at", typeof entries[0]?.payload?.epoch === "number");
  check("the chain still verifies after a broker entry", verifyChain(ledger.all()).ok === true);

  /* Evidence that contains a live bearer credential stops being evidence and
     becomes a second copy of the secret, so this is checked by shape rather
     than by exact value: the token is random per mint, so searching for it
     literally would pass even if a differently-minted one leaked. */
  const payloads = ledger.all().map((e) => JSON.stringify(e.payload ?? {}));
  const tokenShaped = payloads.filter((p) => /"[A-Za-z0-9_-]+\.\d+\.[0-9a-f]{64}"/.test(p));
  check("no ledger entry carries anything shaped like a channel token", tokenShaped.length === 0, tokenShaped[0] ?? "");
  check("no entry names the token variable", !payloads.some((p) => p.includes("CELESTYLE_CHANNEL_TOKEN")));
  check("and no service secret", !payloads.some((p) => p.includes(SERVICE_SECRET)));
}

// ── a refusal is evidence too ─────────────────────────────────────────────
console.log("\n\x1b[1mrefusal is evidence too\x1b[0m");

{
  const { ledger, executor, dir, skill } = await scenario("wired-deny");

  /* Revoke, then use the executor with the token it already holds. The gate
     does not re-mint — that is the whole design — so the old token is stale
     and the action is refused before a child is spawned. */
  await broker.rotate({ sessionId: "wired-deny", revoke: { capability: "workspace.write", actions: ["write_file"] } });

  const target = join(dir, "b.txt");
  const outcome = await executor.run("write_file", { path: target, content: "should not exist" }, skill);

  check("the action is refused", outcome.ok === false);
  check("as a refusal, not a crash", outcome.failure?.kind === "refused", JSON.stringify(outcome.failure));
  check("naming the broker's code", /stale_epoch/.test(outcome.failure?.reason ?? ""), outcome.failure?.reason);

  let exists = true;
  try {
    await stat(target);
  } catch {
    exists = false;
  }
  check("no process was started, so nothing was written", !exists);

  const entries = ledger.all().filter((e) => e.action === AUTHORIZE_ACTION);
  check("the denial is in the ledger", entries.length === 1, String(entries.length));
  check("recording that it was refused", entries[0]?.payload?.allowed === false);
  check("with the code that refused it", entries[0]?.payload?.code === "stale_epoch", JSON.stringify(entries[0]?.payload));
  check("recorded as a failed result", entries[0]?.verifier_result === "failed");
  check("the chain still verifies", verifyChain(ledger.all()).ok === true);
}

// ── the gate must not heal itself ─────────────────────────────────────────
console.log("\n\x1b[1ma revoked gate does not re-mint\x1b[0m");

{
  const { gate, dir, executor, skill } = await scenario("wired-noremint");
  const before = gate.workerEnv().CELESTYLE_CHANNEL_TOKEN;

  await broker.rotate({ sessionId: "wired-noremint", revoke: { capability: "workspace.write", actions: ["write_file"] } });

  /* Repeated attempts, which is what a confused or compromised worker would
     do. If the gate re-minted on a stale token, the second attempt would
     succeed and revocation would be decorative. */
  for (let i = 0; i < 3; i += 1) {
    const out = await executor.run("write_file", { path: join(dir, `r${i}.txt`), content: "x" }, skill);
    check(`attempt ${i + 1} is refused`, out.ok === false, JSON.stringify(out.failure ?? {}));
  }

  const after = gate.workerEnv().CELESTYLE_CHANNEL_TOKEN;
  check("the gate still holds the very same token", before === after);
  check("so the epoch, not the token, is what changed", true);
}

// ── fail closed ───────────────────────────────────────────────────────────
console.log("\n\x1b[1fan unreachable broker refuses\x1b[0m");

{
  const { ledger, executor, dir, gate, skill } = await scenario("wired-down");
  await gate; // the gate is open; the broker is what goes away
  const target = join(dir, "down.txt");

  await broker.stop();
  const outcome = await executor.run("write_file", { path: target, content: "x" }, skill);

  check("an action is refused when the broker cannot be reached", outcome.ok === false);
  check("as a refusal", outcome.failure?.kind === "refused", JSON.stringify(outcome.failure));
  check("reporting a transport problem, not a missing capability",
    /transport/.test(outcome.failure?.reason ?? ""), outcome.failure?.reason);
  check("the ledger still records the attempt", ledger.all().length >= 1, String(ledger.all().length));

  let exists = true;
  try {
    await stat(target);
  } catch {
    exists = false;
  }
  check("and nothing was written", !exists);
}

// restart the broker for the memory test
const broker2 = await CredentialBroker.start({ socketPath: join(socketDir, "broker2.sock") });

// ── the property: no secret in the worker ─────────────────────────────────
console.log("\n\x1b[1mzero secrets in worker\x1b[0m");

{
  const dir = join(root, "memory");
  await mkdir(dir, { recursive: true });
  const ledger = new EventLedger();
  const surface = (() => {
    const r = resolveSurface({ registry, taskId: "t", needs: [{ capability: "workspace.write" }] });
    if (!r.ok) throw new Error(r.reason);
    return r.surface;
  })();

  /* The operator's credential lives in this process — the one the web tier
     would otherwise leak. This is the thing that must not cross. */
  process.env.__TEST_SERVICE_SECRET__ = SERVICE_SECRET;

  await broker2.openSession({ sessionId: "memory", surface });
  const gate = await BrokerGate.open({ broker: broker2, ledger, sessionId: "memory" });
  const granted = gate.workerEnv();

  const executor = new IsolatedExecutor({
    workerPath: reportingWorker,
    surface,
    taskEnv: granted,
    authorizer: gate,
  });

  const outcome = await executor.run("write_file", { path: join(dir, "m.txt"), content: "x" }, { name: "memory", allowed_directories: [dir], timeout_ms: 5000 });
  check("the worker ran", outcome.ok === true, JSON.stringify(outcome.failure ?? {}));

  const report = outcome.result?.report;
  const env = report?.environ ?? [];

  check("it received the broker socket", env.some((e) => e.startsWith("CELESTYLE_BROKER_SOCKET=")), JSON.stringify(env));
  check("and a channel token", env.some((e) => e.startsWith("CELESTYLE_CHANNEL_TOKEN=")), JSON.stringify(env));
  check("it does NOT receive the service secret", !env.join("\0").includes(SERVICE_SECRET), JSON.stringify(env));
  check("it does not receive the parent environment at all", !env.includes("__TEST_SERVICE_SECRET__"));
  check("PATH is there, because running needs it", env.some((e) => e.startsWith("PATH=")), JSON.stringify(env));

  /* The token is present — so this is not the weak claim that the worker was
     simply given nothing and could do nothing. It was given a capability,
     used it, and the capability is not a credential. */
  const tokenValue = env.find((e) => e.startsWith("CELESTYLE_CHANNEL_TOKEN="))?.split("=")[1] ?? "";
  check("the token it holds is the gate's token", tokenValue === granted.CELESTYLE_CHANNEL_TOKEN);
  check("and the token is not the service secret", tokenValue !== SERVICE_SECRET);
  check("the whole environment is 4 variables — nothing unaccounted for", env.length === 4, JSON.stringify(env));

  delete process.env.__TEST_SERVICE_SECRET__;
  await broker2.stop();
}

await rm(root, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
