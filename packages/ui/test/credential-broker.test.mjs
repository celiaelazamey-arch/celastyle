/**
 * Credential broker — L1: the channel token and the epoch.
 *
 * The property under test is narrow and is the reason an epoch exists:
 *
 *     A capability revoked at epoch N+1 stops working at epoch N+1.
 *
 * Not "stops working when the token expires". That is the whole difference
 * between revoking access and announcing that access will end, and a test
 * that only checked eventual expiry would pass against a system with no
 * revocation at all.
 *
 * These run against a real broker process over a real unix socket, not an
 * in-process instance. The separation is the feature — a broker in the same
 * heap would keep the secret away from the worker but not from the web tier,
 * and the web tier is the thing that parses untrusted request bodies.
 */
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CredentialBroker } from "../.test-build-workspace/credential-broker.js";
import { ToolRegistry, resolveSurface } from "../.test-build-workspace/capabilities.js";
/* Resolved explicitly rather than by a relative path: the tests live three
   levels from the repo root, and a relative import that silently points at
   nothing is a failure that shows up as a missing module rather than as the
   thing that is actually wrong. */
const brokerCore = await import(
  resolve(new URL(".", import.meta.url).pathname, "../../../apps/command-center/app/lib/broker/broker-core.mjs")
);
const { createBroker } = brokerCore;

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

const root = await mkdtemp(join(tmpdir(), "broker-"));
const socketDir = join(root, "run");
await mkdir(socketDir, { recursive: true });

const registry = new ToolRegistry()
  .register({
    id: "storage",
    grants: [
      { action: "storage.read", capability: "storage.read", scopes: ["account:primary"], risk: "medium", requiresApproval: false },
      { action: "storage.write", capability: "storage.write", scopes: ["account:primary"], risk: "high", requiresApproval: true },
    ],
  })
  .register({
    id: "mail",
    grants: [
      { action: "mail.read", capability: "mail.read", scopes: ["account:primary"], risk: "low", requiresApproval: false },
    ],
  });

const surfaceFor = (needs) => {
  const resolved = resolveSurface({ registry, taskId: "t", needs });
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.surface;
};

// ── the core decisions, in process ────────────────────────────────────────
console.log("\n\x1b[1mthe four checks\x1b[0m");

{
  const broker = createBroker({ secret: "test-secret" });
  broker.openSession({
    sessionId: "s1",
    grants: { "storage.read": { risk: "medium" } },
    actionToCapability: { "storage.read": "storage.read" },
    scopes: ["account:primary"],
  });
  const { token, epoch } = broker.mint("s1");

  check("a session opens at epoch 1", epoch === 1, String(epoch));
  const allowed = broker.authorize({ token, action: "storage.read", resource: "account:primary/file.txt" });
  check("a granted action on a granted resource is allowed", allowed.allowed === true, JSON.stringify(allowed));
  check("and it reports what was exercised",
    allowed.allowed === true && allowed.authorization.capability === "storage.read");
  check("with the epoch attached, so the evidence says when",
    allowed.allowed === true && allowed.authorization.epoch === 1);

  const notGranted = broker.authorize({ token, action: "mail.read", resource: "account:primary" });
  check("an action the session never had is refused", notGranted.allowed === false);
  check("as not_granted", notGranted.code === "not_granted", notGranted.code);
  check("and says what it did hold", /storage.read/.test(notGranted.reason), notGranted.reason);

  const outOfScope = broker.authorize({ token, action: "storage.read", resource: "account:someone-else/f.txt" });
  check("a resource outside the scope is refused", outOfScope.allowed === false);
  check("as out_of_scope", outOfScope.code === "out_of_scope", outOfScope.code);

  const noToken = broker.authorize({ action: "storage.read" });
  check("no token at all is refused", noToken.allowed === false && noToken.code === "unauthenticated");

  const forged = broker.authorize({ token: `s1.1.deadbeef`, action: "storage.read" });
  check("a forged signature is refused", forged.allowed === false && forged.code === "unauthenticated", forged.code);

  const wrongBroker = createBroker({ secret: "a-different-secret" });
  wrongBroker.openSession({ sessionId: "s1", grants: { "storage.read": { risk: "medium" } }, actionToCapability: { "storage.read": "storage.read" }, scopes: [] });
  const crossBroker = wrongBroker.authorize({ token, action: "storage.read" });
  check("a token from another broker is refused here", crossBroker.allowed === false && crossBroker.code === "unauthenticated");
}

// ── the epoch: revocation is immediate ────────────────────────────────────
console.log("\n\x1b[1mrevocation takes effect at once\x1b[0m");

{
  const broker = createBroker({ secret: "test-secret" });
  broker.openSession({
    sessionId: "s2",
    grants: { "storage.read": { risk: "medium" }, "storage.write": { risk: "high" } },
    actionToCapability: { "storage.read": "storage.read", "storage.write": "storage.write" },
    scopes: ["account:primary"],
  });

  const before = broker.mint("s2");
  check("write is allowed before the revoke", broker.authorize({ token: before.token, action: "storage.write", resource: "account:primary/x" }).allowed === true);

  broker.rotate("s2", { revoke: { capability: "storage.write" } });

  /* The token is byte-for-byte the one that worked a moment ago. Nothing
     was recalled, nothing expired, no timeout ran. It simply stopped
     working, and that is the entire claim. */
  const after = broker.authorize({ token: before.token, action: "storage.write", resource: "account:primary/x" });
  check("the very same token is refused immediately after the revoke", after.allowed === false, JSON.stringify(after));
  check("as stale_epoch, not not_granted",
    after.allowed === false && after.code === "stale_epoch", after.code);
  check("and the reason distinguishes it from a policy refusal",
    after.allowed === false && /epoch/.test(after.reason), after.reason);

  // The read was not revoked, but the session moved, so the old token is
  // stale for it too — which is correct: the token described a state that
  // no longer exists.
  const readOld = broker.authorize({ token: before.token, action: "storage.read", resource: "account:primary/x" });
  check("an unrevoked action on the old token is stale too", readOld.allowed === false && readOld.code === "stale_epoch");

  const refreshed = broker.mint("s2");
  check("a freshly minted token works again", broker.authorize({ token: refreshed.token, action: "storage.read" }).allowed === true);
  check("but the revoked capability is still gone on the new token",
    broker.authorize({ token: refreshed.token, action: "storage.write", resource: "account:primary/x" }).allowed === false);
  check("and it is gone because it was removed, not because of the epoch",
    broker.authorize({ token: refreshed.token, action: "storage.write" }).code === "not_granted");
}

{
  // A grant must advance the epoch too, or a token minted before a
  // capability arrived could not be used to exercise it — which would make
  // escalation silently not work and tempt someone to "fix" it by not
  // checking the epoch on the way up.
  const broker = createBroker({ secret: "s" });
  broker.openSession({ sessionId: "s3", grants: {}, actionToCapability: {}, scopes: [] });
  const before = broker.mint("s3");
  const escalated = broker.rotate("s3", {
    grant: { capability: "storage.read", actionToCapability: { "storage.read": "storage.read" } },
  });
  check("a grant advances the epoch", escalated.epoch === before.epoch + 1, `${before.epoch} -> ${escalated.epoch}`);
  check("so the pre-grant token is stale",
    broker.authorize({ token: before.token, action: "storage.read" }).code === "stale_epoch");
  const after = broker.mint("s3");
  check("and the new token exercises the new capability",
    broker.authorize({ token: after.token, action: "storage.read" }).allowed === true);
}

{
  // Re-opening must not be a reset, or a client could clear a revoke by
  // asking nicely.
  const broker = createBroker({ secret: "s" });
  broker.openSession({ sessionId: "s4", grants: { "a": { risk: "low" } }, actionToCapability: { a: "cap.a" }, scopes: [] });
  const before = broker.mint("s4");
  broker.rotate("s4", { revoke: { capability: "cap.a" } });
  const reopened = broker.openSession({ sessionId: "s4", grants: { a: { risk: "low" } }, actionToCapability: { a: "cap.a" }, scopes: [] });
  check("re-opening reports that it reused the session", reopened.reused === true);
  check("and does not restore the revoked capability",
    broker.authorize({ token: before.token, action: "a" }).allowed === false);
  check("the epoch did not move backwards", reopened.epoch === 2, String(reopened.epoch));
}

// ── a real broker, over a real socket ─────────────────────────────────────
console.log("\n\x1b[1ma standalone broker process\x1b[0m");

const socketPath = join(socketDir, "broker.sock");
let broker;
try {
  broker = await CredentialBroker.start({ socketPath });

  check("the broker process started", true);
  check("and created its socket", (await stat(socketPath)).isSocket());

  /* The socket mode is the isolation. A broker socket anyone local can
     reach is a broker whose isolation is decorative. */
  const mode = (await stat(socketPath)).mode & 0o777;
  check("the socket is owner-only", mode === 0o600, "0" + mode.toString(8));

  const surface = surfaceFor([{ capability: "storage.read" }]);
  const opened = await broker.openSession({ sessionId: "live-1", surface });
  check("a session opened over a real socket", opened.epoch === 1, String(opened.epoch));

  const { token } = await broker.mint("live-1");
  const allowed = await broker.authorize({ token, action: "storage.read", resource: "account:primary/a.txt" });
  check("a granted request is allowed through the socket", allowed.allowed === true, JSON.stringify(allowed));
  check("and it carries evidence for the ledger",
    allowed.allowed === true && allowed.authorization.sessionId === "live-1");

  const wrongAction = await broker.authorize({ token, action: "storage.write", resource: "account:primary/a.txt" });
  check("an ungranted action is refused through the socket", wrongAction.allowed === false);
  check("as not_granted", wrongAction.code === "not_granted", wrongAction.code);

  // Revocation across the process boundary, which is where it would matter.
  await broker.rotate({ sessionId: "live-1", revoke: { capability: "storage.read", actions: ["storage.read"] } });
  const revoked = await broker.authorize({ token, action: "storage.read", resource: "account:primary/a.txt" });
  check("the same token is refused the moment a revoke crosses the socket",
    revoked.allowed === false, JSON.stringify(revoked));
  check("as stale_epoch", revoked.code === "stale_epoch", revoked.code);

  const state = await broker.inspect("live-1");
  check("the broker reports the session as empty of capabilities", state?.capabilities.length === 0, JSON.stringify(state));
  check("and never hands out a token through inspect", JSON.stringify(state).indexOf("token") === -1);

  const unknown = await broker.authorize({ token: "nobody.1.abcdef", action: "storage.read" });
  check("a token for a session that does not exist is refused",
    unknown.allowed === false && unknown.code === "unauthenticated", unknown.code);

  await broker.stop();
  check("the broker stopped cleanly", true);
} catch (error) {
  check(`the broker process should have started: ${error.message}`, false);
  await broker?.stop().catch(() => {});
}

await rm(root, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
