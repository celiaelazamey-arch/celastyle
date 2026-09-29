/**
 * Event Ledger — tamper detection.
 *
 * A hash chain earns its name by catching edits, so nearly every test here
 * corrupts a real chain and asserts that verification notices. A test suite
 * that only appends and then verifies an untouched chain proves nothing:
 * the original sketch hashed action, payload and result but left the
 * timestamp and index outside the commitment, so it verified perfectly while
 * being freely editable in the two fields that matter most for an alibi.
 *
 * One expectation in this file was wrong when first written, and the failure
 * was informative rather than annoying — see "timestamp tampering" below.
 */
import { EventLedger, verifyChain, canonicalize, computeHash, GENESIS_HASH } from "../.test-build-workspace/event-ledger.js";

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

const kinds = (result) => result.problems.map((p) => p.kind);

/** A small chain with one success and one failure, enough to link. */
function seed() {
  const ledger = new EventLedger();
  ledger.append({
    action: "fs.write",
    payload: { path: "notes/a.md", content: "hello" },
    verifier_result: "success",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  ledger.append({
    action: "git.commit",
    payload: { message: "wip" },
    verifier_result: "success",
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  ledger.append({
    action: "test.run",
    payload: { suite: "unit" },
    verifier_result: "failed",
    timestamp: "2026-01-01T00:00:02.000Z",
  });
  return ledger;
}

// ── the baseline: an untouched chain is valid ──────────────────────────────
console.log("\n\x1b[1muntouched chain\x1b[0m");

{
  const ledger = seed();
  const result = ledger.verify();
  check("a freshly written chain verifies", result.ok, JSON.stringify(result.problems));
  check("its length is reported", result.length === 3);
  check("its head is the last entry's hash", result.head === ledger.all()[2].current_hash);
  check("the first entry links to genesis", ledger.all()[0].previous_hash === GENESIS_HASH);
  check("later entries link to their predecessor",
    ledger.all()[1].previous_hash === ledger.all()[0].current_hash &&
    ledger.all()[2].previous_hash === ledger.all()[1].current_hash);
}

// ── 1. deterministic hashing ───────────────────────────────────────────────
console.log("\n\x1b[1mdeterministic hashing\x1b[0m");

{
  // Replay compares two runs. If key order changed the hash, a run would
  // never match itself, and "replay" would be decorative.
  const a = canonicalize({ path: "/a", content: "x", mode: "r" });
  const b = canonicalize({ mode: "r", content: "x", path: "/a" });
  check("key order does not change canonical form", a === b, `${a} vs ${b}`);
  check("nested keys are sorted too",
    canonicalize({ outer: { z: 1, a: 2 } }) === canonicalize({ outer: { a: 2, z: 1 } }));

  // Arrays carry meaning, so their order must NOT be normalised away.
  check("array order is preserved",
    canonicalize({ steps: ["a", "b"] }) !== canonicalize({ steps: ["b", "a"] }));

  /* A collision is a hole. JSON.stringify drops undefined-valued keys, so
     these two would hash the same and a key could be added or removed
     without breaking the chain. */
  check("an undefined value is not silently dropped",
    canonicalize({ a: 1, b: undefined }) !== canonicalize({ a: 1 }));
  check("undefined canonicalises to null",
    canonicalize({ a: undefined }) === '{"a":null}');
  check("non-finite numbers do not throw", canonicalize({ n: NaN }) === '{"n":null}');

  // Two separately built chains with identical events hash identically.
  const one = new EventLedger();
  one.append({ action: "x", payload: { k: 1 }, verifier_result: "success", timestamp: "T", id: "i" });
  const two = new EventLedger();
  two.append({ action: "x", payload: { k: 1 }, verifier_result: "success", timestamp: "T", id: "i" });
  check("identical events produce identical hashes",
    one.all()[0].current_hash === two.all()[0].current_hash);

  // computeHash is the single source both append and verify use.
  const e = seed().all()[1];
  const recomputed = computeHash({
    index: e.index, id: e.id, timestamp: e.timestamp, action: e.action,
    payload: e.payload, verifier_result: e.verifier_result, previous_hash: e.previous_hash,
  });
  check("computeHash reproduces a recorded hash", recomputed === e.current_hash);
}

// ── 2. timestamp tampering ─────────────────────────────────────────────────
console.log("\n\x1b[1btimestamp tampering\x1b[0m");

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));

  /* The original design left the timestamp out of the hash, so backdating an
     action was undetectable — the one edit an alibi actually needs. */
  entries[0].timestamp = "2019-01-01T00:00:00.000Z";

  const result = verifyChain(entries);
  check("rewriting a timestamp is caught", !result.ok);
  check("it is reported as a content mismatch", kinds(result).includes("content_mismatch"),
    JSON.stringify(kinds(result)));
  check("the affected entry is identified", result.problems.some((p) => p.index === 0));
}

{
  /* Worth being precise about, because the intuitive expectation is wrong.
     The tamperer edits entry 0's timestamp and leaves its stored
     current_hash alone. Entry 1's previous_hash still equals entry 0's
     *stored* hash, so the link does not break — and yet the forgery is still
     caught, because entry 0 no longer hashes to what it claims.

     This is the difference between "the chain is intact" and "the records
     are true". Tampering an entry is caught at that entry; tampering a
     *link* (previous_hash) is what produces a broken_link report. */
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[0].timestamp = "2019-01-01T00:00:00.000Z";
  const result = verifyChain(entries);
  check("an untouched link is not falsely reported as broken",
    !kinds(result).includes("broken_link"),
    JSON.stringify(kinds(result)));
  check("the forgery is caught on its own entry all the same",
    kinds(result).includes("content_mismatch"));
  check("and only the tampered entry is named",
    result.problems.length === 1 && result.problems[0].index === 0,
    JSON.stringify(result.problems));
}

{
  // Editing a link directly IS a broken link, which is a different report.
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[1].previous_hash = "a".repeat(64);
  const result = verifyChain(entries);
  check("rewriting a link is reported as a broken link", kinds(result).includes("broken_link"));
  check("and also as a content mismatch, since previous_hash is hashed",
    kinds(result).includes("content_mismatch"));
}

// ── 3. sequence and insertion ──────────────────────────────────────────────
console.log("\n\x1b[1msequence and insertion\x1b[0m");

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[1].index = 7;
  const result = verifyChain(entries);
  check("renumbering an entry is caught", !result.ok);
  check("it is reported as a sequence gap", kinds(result).includes("sequence_gap"));
  check("and as a content mismatch, since index is hashed",
    kinds(result).includes("content_mismatch"));
}

{
  /* Splicing in an invented entry to justify a later one. The inserted entry
     claims a link that the real predecessor does not have. */
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  const forged = {
    index: 1,
    id: "evt-forged",
    timestamp: "2026-01-01T00:00:01.500Z",
    action: "policy.approve",
    payload: { approved: true },
    verifier_result: "success",
    previous_hash: entries[0].current_hash,
    current_hash: "f".repeat(64),
  };
  entries.splice(1, 0, forged);
  const result = verifyChain(entries);
  check("an inserted entry is caught", !result.ok);
  check("the forgery is reported", result.problems.length > 0);
  check("the next real entry is reported as a sequence gap",
    result.problems.some((p) => p.kind === "sequence_gap"));
}

{
  // Removing a middle entry re-points a link that no longer matches.
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries.splice(1, 1);
  const result = verifyChain(entries);
  check("deleting a middle entry is caught", !result.ok);
  check("the orphaned successor is reported as a broken link",
    kinds(result).includes("broken_link"));
}

// ── 4. forging the verifier's verdict or the payload ───────────────────────
console.log("\n\x1b[1mforging results and payloads\x1b[0m");

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[2].verifier_result = "success";
  const result = verifyChain(entries);
  check("flipping a failure to a success is caught", !result.ok);
  check("it is reported as a content mismatch", kinds(result).includes("content_mismatch"));
}

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[0].payload = { path: "/etc/passwd", content: "hello" };
  const result = verifyChain(entries);
  check("rewriting a payload is caught", !result.ok);
  check("it is reported as a content mismatch", kinds(result).includes("content_mismatch"));
}

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[0].action = "fs.delete";
  const result = verifyChain(entries);
  check("rewriting the recorded action is caught", !result.ok);
}

{
  const ledger = seed();
  const entries = ledger.all().map((e) => ({ ...e }));
  entries[0].id = "evt-renamed";
  const result = verifyChain(entries);
  check("rewriting an entry id is caught", !result.ok);
}

// ── shape and empty cases ──────────────────────────────────────────────────
console.log("\n\x1b[1mshape and empty cases\x1b[0m");

{
  check("an empty chain is valid", verifyChain([]).ok);
  check("an empty chain's head is genesis", verifyChain([]).head === GENESIS_HASH);
  check("an empty ledger seals to genesis", new EventLedger().seal() === GENESIS_HASH);

  const result = verifyChain([null]);
  check("a malformed entry is reported", !result.ok);
  check("as not_an_entry", kinds(result).includes("not_an_entry"));

  check("an array in place of an entry is reported",
    kinds(verifyChain([["nope"]])).includes("not_an_entry"));
}

// ── the limit of a chain, stated rather than implied ───────────────────────
console.log("\n\x1b[1mwhat a chain cannot detect\x1b[0m");

{
  /* The honest limit. A chain proves nothing has been edited; it cannot prove
     nothing was removed from the end, because a shorter chain still links up
     correctly. This is a property of the construction, not a bug, so the test
     asserts the real behaviour: truncation passes verify() and is caught only
     by comparing a seal stored elsewhere. */
  const ledger = seed();
  const fullSeal = ledger.seal();
  const truncated = ledger.all().slice(0, 2).map((e) => ({ ...e }));

  check("a truncated chain still verifies by itself", verifyChain(truncated).ok === true);
  check("so truncation is invisible without a seal", truncated.length === 2);
  check("and the seal is what differs", fullSeal !== truncated[1].current_hash);
  check("the seal of the full chain is its last hash", fullSeal === ledger.all()[2].current_hash);

  const empty = new EventLedger();
  check("a fresh ledger seals to genesis", empty.seal() === GENESIS_HASH);
}

// ── durability: memory and disk must never disagree ───────────────────────
/*
 * A ledger that has diverged from its own file is the one failure the hash
 * chain cannot catch, because the chain in memory is intact. These tests
 * drive a real failing sink and assert the invariant that matters: an entry
 * is in the chain if and only if it is on disk.
 */
console.log("\n\x1b[1mdurability: a failed write must leave no trace in memory\x1b[0m");

{
  const onDisk = [];
  let failing = false;
  const sink = {
    write(line) {
      if (failing) throw new Error("ENOSPC: no space left on device");
      onDisk.push(JSON.parse(line));
    },
  };
  const ledger = new EventLedger([], sink);

  ledger.append({ action: "step-0", verifier_result: "passed" });
  const afterFirst = ledger.length;

  failing = true;
  let thrown = null;
  try {
    ledger.append({ action: "step-1", verifier_result: "passed" });
  } catch (error) {
    thrown = error.message;
  }

  check("the write failure surfaces to the caller", (thrown ?? "").includes("ENOSPC"), String(thrown));
  check("the failed entry did NOT enter the in-memory chain", ledger.length === afterFirst,
    `${ledger.length} vs ${afterFirst}`);
  check("the in-memory tail is still the last real entry", ledger.all().at(-1).action === "step-0");
  check("nothing was written to the sink either", onDisk.length === 1, `${onDisk.length}`);

  // The chain the agent believes in is still a real chain.
  check("memory still verifies clean", ledger.verify().ok === true);
  check("with no phantom entry inside it", ledger.verify().length === 1);

  /* The failure that the old ordering made permanent: recovery. The next
     append reads its previous_hash from whatever is at the tail, so if a
     phantom had survived, the entry written to disk would link to a hash
     nothing on disk produces. */
  failing = false;
  ledger.append({ action: "step-2", verifier_result: "passed" });

  const onDiskChain = new EventLedger(onDisk);
  check("after recovery the durable chain verifies", onDiskChain.verify().ok === true,
    JSON.stringify(onDiskChain.verify().problems));
  check("and holds exactly the two real entries", onDiskChain.length === 2);
  check("memory and disk now agree", ledger.length === onDisk.length);
  check("and agree entry for entry",
    ledger.all().every((e, i) => e.current_hash === onDisk[i].current_hash));
  check("no sequence gap was left behind",
    onDisk.every((e, i) => e.index === i), JSON.stringify(onDisk.map(e => e.index)));
  check("every link resolves to the entry before it",
    onDisk.slice(1).every((e, i) => e.previous_hash === onDisk[i].current_hash));
}

{
  // A ledger with no sink is in-memory by design and must not be treated as
  // a failed write. This is the case the ordering change could plausibly
  // have broken, so it is asserted rather than assumed.
  const memoryOnly = new EventLedger();
  memoryOnly.append({ action: "a", verifier_result: "passed" });
  memoryOnly.append({ action: "b", verifier_result: "passed" });
  check("an in-memory ledger still appends normally", memoryOnly.length === 2);
  check("and verifies", memoryOnly.verify().ok === true);
}

{
  // The order of the two operations is the whole fix, so it is asserted
  // directly rather than inferred from the failure behaviour above: at the
  // moment the sink is written, the entry must not yet be reachable.
  const seen = [];
  let lengthDuringWrite = null;
  const ledger = new EventLedger([], {
    write() {
      // Called before the push, so the chain is still short.
      lengthDuringWrite = ledger.length;
    },
  });
  ledger.append({ action: "solo", verifier_result: "passed" });
  check("the sink is written before the entry joins the chain", lengthDuringWrite === 0,
    String(lengthDuringWrite));
  check("and the entry is in the chain once the write returns", ledger.length === 1);
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
