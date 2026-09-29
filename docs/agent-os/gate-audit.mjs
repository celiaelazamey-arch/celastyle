import { createHash } from "node:crypto";

/* Executable audit of the three proposed components.
   Each section states the claim in the design, then tests it. No assertion
   here is taken on faith from the TypeScript sketch. */

// ─────────────────────────────────────────────────────────────────────────────
// 1. ExecutionAuthority — the approval gate
// ─────────────────────────────────────────────────────────────────────────────

class ExecutionAuthority {
  async authorizeAction(proposedTool, skill, payload) {
    if (!skill.allowed_tools.includes(proposedTool)) {
      throw new Error(`Security Violation: Tool ${proposedTool} not allowed for ${skill.name}`);
    }
    if (skill.risk_level === "high" || skill.requires_human_approval) {
      const approved = await this.requestHumanApproval(skill.name, payload);
      if (!approved) return false;
    }
    return true;
  }
  // The design left this as a stub. What does it actually return?
  async requestHumanApproval() {}
}

const authority = new ExecutionAuthority();

// A medium-risk skill. The spec says medium AND high both require approval.
const mediumSkill = {
  name: "fs-write-safe",
  risk_level: "medium",
  requires_human_approval: false, // schema default
  allowed_tools: ["write_file", "read_file"],
};

const authResult = await authority.authorizeAction("write_file", mediumSkill, {});
console.log("1. MEDIUM-RISK SKILL, approval flag left at its schema default");
console.log(`   authorized: ${authResult}`);
console.log(`   → spec says Medium requires an approval gate. Got: ${authResult}`);
console.log(
  `   → FAIL-OPEN: the only thing blocking a medium-risk tool is a boolean the`,
);
console.log(
  `     skill author must remember to set. default:false makes silence mean "go".`,
);

// Does the gate ever look at the payload?
const outsideWorkspace = {
  proposedTool: "write_file",
  skill: mediumSkill,
  payload: { path: "/etc/passwd", content: "owned" },
};
const pathResult = await authority.authorizeAction(
  "write_file",
  mediumSkill,
  outsideWorkspace.payload,
);
console.log(`\n   same skill, payload targeting /etc/passwd → authorized: ${pathResult}`);
console.log(`   → the gate validates the TOOL NAME and never the ARGUMENTS.`);
console.log(`     allowed_tools:["write_file"] is satisfied by a write to any path.`);

// The stub's real return value
const stub = await new ExecutionAuthority().requestHumanApproval("x", {});
console.log(`\n   requestHumanApproval() stub returns: ${stub} (typeof ${typeof stub})`);
console.log(`   → undefined is falsy, so every high-risk skill is denied today.`);
console.log(`     That is safe by accident, not by design — it flips the moment`);
console.log(`     someone implements the stub to return undefined on "not yet".`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. EventLedger — tamper evidence
// ─────────────────────────────────────────────────────────────────────────────

class EventLedger {
  constructor() { this.ledger = []; }
  appendEvent(action, payload, verifierResult) {
    const previousHash =
      this.ledger.length > 0 ? this.ledger[this.ledger.length - 1].current_hash : "GENESIS_HASH";
    const dataToHash = JSON.stringify({ action, payload, verifierResult, previousHash });
    const currentHash = createHash("sha256").update(dataToHash).digest("hex");
    const entry = {
      id: this.ledger.length + 1,
      timestamp: new Date().toISOString(),
      action, payload, verifier_result: verifierResult,
      previous_hash: previousHash, current_hash: currentHash,
    };
    this.ledger.push(entry);
    return entry;
  }
}

const ledger = new EventLedger();
const a = ledger.appendEvent("fs.write", { path: "a.txt", content: "hello" }, "success");
const b = ledger.appendEvent("git.commit", { message: "wip" }, "success");

// The design states a hash chain provides tamper evidence. That requires a
// verifier. There is none in the sketch, so here is the one it needs:
function verifyChain(entries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = i > 0 ? entries[i - 1].current_hash : "GENESIS_HASH";
    if (e.previous_hash !== prev) return `entry ${e.id}: broken link`;
    // Key names must match the ledger exactly, or this verifies nothing.
    const expected = createHash("sha256")
      .update(JSON.stringify({
        action: e.action, payload: e.payload,
        verifierResult: e.verifier_result, previousHash: prev,
      }))
      .digest("hex");
    if (expected !== e.current_hash) return `entry ${e.id}: content does not match hash`;
  }
  return null;
}

console.log(`\n2. HASH CHAIN — "prevents the agent from forgetting what it did"`);
console.log(`   intact chain verifies: ${verifyChain(ledger.ledger) === null ? "OK" : "BROKEN"}`);

// Tamper with the timestamp — the field a tamperer would edit to hide when
// something actually happened.
const originalTimestamp = b.timestamp;
b.timestamp = "2019-01-01T00:00:00.000Z";
const afterTimestampTamper = verifyChain(ledger.ledger);
console.log(`   timestamp rewritten → verify: ${afterTimestampTamper === null ? "STILL OK" : afterTimestampTamper}`);
console.log(`   → the hash does not commit to the timestamp.`);
console.log(`     Rewriting when an action occurred is undetectable.`);

// Tamper with the id — sequence position.
b.id = 99;
console.log(`   id rewritten to 99    → verify: ${verifyChain(ledger.ledger) === null ? "STILL OK" : verifyChain(ledger.ledger)}`);
console.log(`   → the hash does not commit to the id either.`);
b.id = 2; b.timestamp = originalTimestamp;

// Canonical serialisation: same logical event, different key order.
const l2 = new EventLedger();
l2.appendEvent("fs.write", { path: "a.txt", content: "hello" }, "success");
l2.appendEvent("git.commit", { content: "x", message: "wip" }, "success"); // same keys, reordered
const e1 = l2.ledger[0].current_hash;
const l3 = new EventLedger();
l3.appendEvent("fs.write", { content: "hello", path: "a.txt" }, "success");
l3.appendEvent("git.commit", { message: "wip", content: "x" }, "success");
const e2 = l3.ledger[0].current_hash;
console.log(`\n   same event, different key order → same hash: ${e1 === e2}`);
console.log(`   → JSON.stringify is not canonical, so replay cannot compare runs.`);
console.log(`     The stated goal is "replay", and replay needs determinism.`);

// Durability
console.log(`\n   ledger lives in: ${Array.isArray(ledger.ledger) ? "an in-memory array" : "?"}`);
console.log(`   → "append-only" describes the intent, not the storage. Nothing is`);
console.log(`     written to disk, so the chain dies with the process.`);
console.log(`   → and there is no verifyChain() or rollback() in the design at all,`);
console.log(`     which are the only two things an append-only ledger is for.`);
