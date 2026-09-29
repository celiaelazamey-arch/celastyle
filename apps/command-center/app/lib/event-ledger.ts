import { createHash } from "node:crypto";

/* =============================================================================
   Event Ledger
   -----------------------------------------------------------------------------
   An append-only, hash-chained record of what the agent did and what the
   verifier found. The point is not to store events — it is to make the record
   unfalsifiable after the fact.

   A hash chain is only worth what its verifier is worth, so the same module
   owns the check. `verify()` recomputes every link from the entry data itself
   rather than trusting a stored hash, which is the only way a tamper can be
   caught at all.

   Three defects in the original sketch are fixed here, each of which would
   have made the chain decorative:

   1. The hash committed to action, payload, result and the previous hash —
      but NOT the timestamp and NOT the sequence number. Rewriting *when* an
      action happened was undetectable. Both are inside the hash now.
   2. `JSON.stringify` is not canonical. The same object with its keys in a
      different order hashes differently, so replay could never compare two
      runs. `canonicalize` sorts keys recursively.
   3. It lived in an array, so "append-only" described an intention rather
      than a storage. Entries append to a JSONL file, and the file is opened
      in append mode so a shorter rewrite cannot silently truncate it.

   The one thing a chain cannot do is catch its own tail being cut: removing
   the last entry leaves a shorter chain that still verifies. `seal()` exists
   for that — it returns a head commitment you store somewhere the ledger
   cannot reach. Without a seal, truncation is invisible, and this module
   says so rather than implying otherwise.
   ========================================================================== */

export type VerifierResult = "success" | "failed";

export type LedgerEntry = {
  /** Position in the chain, 0-based. Inside the hash. */
  index: number;
  /** Stable identity for the entry. Inside the hash. */
  id: string;
  /** ISO-8601. Inside the hash. */
  timestamp: string;
  action: string;
  payload: unknown;
  verifier_result: VerifierResult;
  previous_hash: string;
  current_hash: string;
};

/** A fixed, obviously-synthetic first link. Any chain not starting here is suspect. */
export const GENESIS_HASH = "0".repeat(64);

/* ============================================================================
   Canonical serialisation
   ========================================================================= */

/**
 * Deterministic JSON: object keys sorted, recursively.
 *
 * Arrays keep their order, because array order is meaning — a list of steps
 * run in a different order is a different run, not a re-spelling of one.
 *
 * `undefined` becomes `null` rather than being omitted. This is a security
 * decision, not a formatting one: `JSON.stringify` drops undefined-valued
 * keys, so `{a: 1, b: undefined}` and `{a: 1}` would otherwise produce the
 * same hash, and an attacker could add or remove a key without breaking the
 * chain. Collisions are holes.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  const type = typeof value;

  if (type === "number") {
    // NaN and Infinity serialise to null in JSON.stringify, and comparing
    // them as strings is meaningless. Pinning them keeps the function total.
    return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (type === "undefined" || type === "function" || type === "symbol") return "null";

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    // Every own key is emitted, including those holding undefined, so that
    // the key's *presence* is part of the commitment.
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }

  return "null";
}

/**
 * The one place a hash is computed.
 *
 * Append and verify both call this. If they computed it separately they would
 * drift, and a drift between the two is indistinguishable from tampering —
 * the verifier would report an honest ledger as corrupt, and a corrupt one
 * as fine. Field order below is fixed and must not be reordered without
 * re-versioning existing ledgers.
 */
export function computeHash(entry: {
  index: number;
  id: string;
  timestamp: string;
  action: string;
  payload: unknown;
  verifier_result: VerifierResult;
  previous_hash: string;
}): string {
  const canonical = canonicalize({
    action: entry.action,
    id: entry.id,
    index: entry.index,
    payload: entry.payload,
    previous_hash: entry.previous_hash,
    timestamp: entry.timestamp,
    verifier_result: entry.verifier_result,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/* ============================================================================
   Verification
   ========================================================================= */

export type TamperKind =
  | "content_mismatch"
  | "broken_link"
  | "sequence_gap"
  | "genesis_mismatch"
  | "not_an_entry";

export type TamperReport = {
  kind: TamperKind;
  /** Position in the chain, or the index of the first bad entry. */
  index: number;
  id?: string;
  detail: string;
};

export type VerifyResult = {
  ok: boolean;
  length: number;
  /** Hash of the final entry, or GENESIS_HASH for an empty chain. */
  head: string;
  problems: TamperReport[];
};

/**
 * Recompute the whole chain and report every disagreement.
 *
 * Checks are not short-circuited: a ledger that was edited in two places
 * should say so twice, and a caller triaging an incident needs the whole
 * picture, not the first failure.
 */
export function verifyChain(entries: unknown[]): VerifyResult {
  const problems: TamperReport[] = [];

  let previousHash = GENESIS_HASH;
  let head = GENESIS_HASH;

  for (let position = 0; position < entries.length; position += 1) {
    const raw = entries[position] as Partial<LedgerEntry> | null | undefined;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push({
        kind: "not_an_entry",
        index: position,
        detail: "entry is not an object",
      });
      // A malformed entry cannot be chained past, but the rest of the ledger
      // is still worth checking so the caller learns the extent of the damage.
      break;
    }

    const entry = raw as LedgerEntry;

    if (entry.index !== position) {
      problems.push({
        kind: "sequence_gap",
        index: position,
        id: entry.id,
        detail: `entry claims index ${String(entry.index)} but sits at ${position}`,
      });
    }

    if (entry.previous_hash !== previousHash) {
      problems.push({
        kind: "broken_link",
        index: position,
        id: entry.id,
        detail: `previous_hash does not match the hash of entry ${position - 1}`,
      });
    }

    // Recomputed from the entry's own fields: this is the check that catches
    // an edit to any committed value, including timestamp, id, the verifier's
    // verdict and the payload.
    const recomputed = computeHash({
      index: entry.index,
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      payload: entry.payload,
      verifier_result: entry.verifier_result,
      previous_hash: entry.previous_hash,
    });

    if (recomputed !== entry.current_hash) {
      problems.push({
        kind: "content_mismatch",
        index: position,
        id: entry.id,
        detail: "entry contents do not match its recorded hash",
      });
    }

    previousHash = entry.current_hash;
    head = entry.current_hash;
  }

  if (entries.length > 0 && head === GENESIS_HASH) {
    problems.push({
      kind: "genesis_mismatch",
      index: 0,
      detail: "a non-empty chain does not terminate in a real entry hash",
    });
  }

  return { ok: problems.length === 0, length: entries.length, head, problems };
}

/* ============================================================================
   The ledger
   ========================================================================= */

export type AppendInput = {
  action: string;
  payload?: unknown;
  verifier_result: VerifierResult;
  id?: string;
  timestamp?: string;
};

export class EventLedger {
  private entries: LedgerEntry[] = [];
  /** When set, each append is written as one JSON line. Append mode only —
   *  the file is never rewritten, so a crash cannot truncate what is there. */
  private sink: { write(line: string): void } | null = null;

  constructor(from: LedgerEntry[] = [], sink: { write(line: string): void } | null = null) {
    this.entries = [...from];
    this.sink = sink;
  }

  static async fromFile(path: string): Promise<EventLedger> {
    const { readFile } = await import("node:fs/promises");
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      // A missing file is a new ledger, not a failure.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new EventLedger();
    }
    const entries = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerEntry);
    return new EventLedger(entries);
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  append(input: AppendInput): LedgerEntry {
    const index = this.entries.length;
    const previous_hash =
      index > 0 ? this.entries[index - 1]!.current_hash : GENESIS_HASH;

    const body = {
      index,
      id: input.id ?? `evt-${index}-${input.action}`,
      timestamp: input.timestamp ?? new Date().toISOString(),
      action: input.action,
      payload: input.payload ?? null,
      verifier_result: input.verifier_result,
      previous_hash,
    };

    const entry: LedgerEntry = {
      ...body,
      current_hash: computeHash(body),
    };

    /* Durability first. The sink is written before the entry joins the
       in-memory chain, and the reason is not tidiness.
     
       The other order produces a failure that is worse than a crash. Push
       first, write second: the write throws, the caller sees an exception,
       but the entry is already in memory. The next append then reads its
       previous_hash from that phantom, writes it to disk, and the durable
       record is left with a hole and a link to an entry nobody can find —
       a permanently broken chain that verifies clean in memory. One full
       disk, and the ledger's whole guarantee is gone while reporting that
       it is intact.
     
       Writing first makes append atomic in the only sense that matters: an
       entry is in the chain if and only if it is on disk. If the write
       throws, nothing entered memory, the next entry links to the last real
       one, and the file stays a valid chain across the outage.
       
       A no-op sink still appends — an in-memory ledger has nothing to
       persist and must not be treated as a failure. */
    if (this.sink) this.sink.write(`${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    return entry;
  }

  verify(): VerifyResult {
    return verifyChain(this.entries);
  }

  /**
   * A commitment to the current head, for storing outside the ledger.
   *
   * A chain cannot detect its own last entries being removed — the remainder
   * still verifies. Comparing this value against a stored one is the only way
   * to notice truncation, so a ledger that is not sealed somewhere else can
   * be quietly shortened.
   */
  seal(): string {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1]!.current_hash
      : GENESIS_HASH;
  }
}
