import type { CapabilityId, ToolSurface, Grant } from "./capabilities";

/* =============================================================================
   Token scopes
   -----------------------------------------------------------------------------
   (surface) → the exact OAuth scopes a credential must carry.

   This module decides what to *ask for*. It never decides what a token can
   *do*, and it never talks to a service to find out. That separation is the
   whole point and it is why the test for it is a fake token service that
   records its request: the assertion belongs on our side of the wire.

   The trap this exists to close is small and real. Google's
   `.../auth/drive` is not "drive" — it is read *and* write *and* delete
   across the entire account, and a request for it on behalf of a read-only
   task succeeds, returns a working token, and grants far more than anyone
   reading the code would expect. A mapping that says `storage.read` needs
   `drive` looks reasonable and is a full-account takeover.

   So the direction of a scope is recorded independently of the binding that
   uses it, and every emitted scope is checked against the capabilities that
   justified it. A mis-authored binding does not silently over-grant; it is
   refused before a token service is contacted. A binding is a claim, and
   the check does not take the claimant's word for it.
   ========================================================================== */

/** What holding a scope lets you do. Ordered, and the order is the point. */
export type Effect = "read" | "write" | "delete" | "admin";

const EFFECT_RANK: Record<Effect, number> = { read: 0, write: 1, delete: 2, admin: 3 };

/**
 * The true effect of each scope, authored by hand and reviewed.
 *
 * Separate from the bindings below on purpose. If a binding also declared
 * its own scope's effect, then binding and truth would be the same claim
 * twice and the check in `resolveTokenSpec` would be comparing a statement
 * against itself. This table is the second opinion.
 */
const SCOPE_EFFECTS: Record<string, Effect> = {
  // Drive. `drive` is the account-wide one and is the reason this file
  // exists; it is admin, not write.
  "https://www.googleapis.com/auth/drive.readonly": "read",
  "https://www.googleapis.com/auth/drive.file": "write",
  "https://www.googleapis.com/auth/drive.metadata.readonly": "read",
  "https://www.googleapis.com/auth/drive": "admin",

  // Gmail. `mail` is everything including settings and other people's mail.
  "https://www.googleapis.com/auth/gmail.readonly": "read",
  "https://www.googleapis.com/auth/gmail.send": "write",
  "https://www.googleapis.com/auth/gmail.compose": "write",
  "https://www.googleapis.com/auth/mail": "admin",

  // Calendar.
  "https://www.googleapis.com/auth/calendar.readonly": "read",
  "https://www.googleapis.com/auth/calendar.events": "write",
  "https://www.googleapis.com/auth/calendar": "admin",
};

/** The narrowest sufficient scopes for one capability. */
export type CapabilityBinding = {
  capability: CapabilityId;
  /** Must be sufficient for the capability and no more. */
  scopes: string[];
  /** Why this is the narrowest set. Read by reviewers, not by code. */
  note?: string;
};

/**
 * The binding table.
 *
 * A capability that is absent here and needs a token is *unavailable*, never
 * "granted a broad one". The alternative — falling back to the service's
 * widest scope so the feature works — recreates precisely the problem this
 * work exists to remove, and does it invisibly.
 *
 * `workspace.*` is absent because it is local and needs no credential at
 * all. That is a different reason from being unbound, and the distinction
 * is carried on the grant as `requiresToken: false` so the two cannot be
 * confused: a forgotten binding and a capability that genuinely needs no
 * secret must not look alike.
 */
export const CAPABILITY_BINDINGS: CapabilityBinding[] = [
  {
    capability: "storage.read",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    note: "readonly, never `drive` — see the header",
  },
  {
    capability: "storage.write",
    // `drive.file` is per-file and per-user, not account-wide. It is the
    // narrowest scope that can create a file, which is what "write" means.
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    note: "per-file, not `drive`; a read-only task never reaches this binding",
  },
  {
    capability: "mail.read",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  {
    capability: "mail.write",
    // `gmail.send` cannot read, cannot draft in the mailbox, cannot change
    // settings. It is sending and nothing else.
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    note: "send only; not `gmail.compose`, which can also keep drafts",
  },
  {
    capability: "calendar.read",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  },
  {
    capability: "calendar.write",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    note: "events only; not `calendar`, which reaches settings and sharing",
  },
];

export type TokenSpec = {
  /** Capabilities that resolved to a binding, sorted. */
  capabilities: CapabilityId[];
  /** The exact scopes to request, deduped and sorted. */
  scopes: string[];
  /** Capabilities needing a token that have no binding. */
  unbound: { capability: CapabilityId; reason: string }[];
};

export type SpecResolution =
  | { ok: true; spec: TokenSpec }
  | { ok: false; reason: string; spec: TokenSpec };

/**
 * The narrowest OAuth scope set that satisfies a surface.
 *
 * Four rules, each of which is a decision rather than an implementation
 * detail:
 *
 * 1. Nothing is inferred. A capability with no binding is unavailable.
 * 2. A scope is emitted only if the surface justifies its effect. A
 *    read-only surface can never produce a write or admin scope, whatever a
 *    binding claims.
 * 3. There is no wildcard, no "everything" scope, and no call that returns
 *    the whole table. A caller wanting more asks for more capabilities, one
 *    at a time, and each is checked.
 * 4. The output is sorted. Two identical surfaces must produce byte-equal
 *    specs, or the thing being signed is not reproducible.
 */
export function resolveTokenSpec(surface: ToolSurface): SpecResolution {
  const byCapability = new Map(CAPABILITY_BINDINGS.map((b) => [b.capability, b]));

  const granted = new Map<CapabilityId, Grant>();
  for (const action of surface.actions()) {
    const grant = surface.grantFor(action);
    if (!grant) continue;
    /* Absent means "needs a token". A capability that genuinely needs none
       says so on its grant, and that is the only way to be exempt. */
    if (grant.requiresToken === false) continue;
    granted.set(grant.capability, grant);
  }

  const unbound: TokenSpec["unbound"] = [];
  const scopes = new Set<string>();
  const resolved: CapabilityId[] = [];

  for (const capability of [...granted.keys()].sort()) {
    const binding = byCapability.get(capability);
    if (!binding) {
      unbound.push({
        capability,
        reason: `"${capability}" needs a credential and has no scope binding, so it is unavailable rather than granted a broad scope`,
      });
      continue;
    }
    for (const scope of binding.scopes) scopes.add(scope);
    resolved.push(capability);
  }

  const spec: TokenSpec = {
    capabilities: resolved,
    scopes: [...scopes].sort(),
    unbound,
  };

  if (resolved.length === 0) {
    return {
      ok: false,
      spec,
      reason:
        unbound.length > 0
          ? `no capability in this surface has a scope binding: ${unbound.map((u) => u.reason).join("; ")}`
          : "this surface needs no credential at all",
    };
  }

  /* Rule 2, the safety net. Every emitted scope's effect is read from the
     independent table and compared against the highest effect the surface
     actually granted. This is what makes a mis-authored binding fail loudly
     instead of quietly asking for an account-wide credential. */
  const ceiling = EFFECT_RANK[highestEffect(granted)];
  for (const scope of spec.scopes) {
    const effect = SCOPE_EFFECTS[scope];
    if (effect === undefined) {
      return {
        ok: false,
        spec,
        reason: `scope "${scope}" has no recorded effect, so its reach is unknown and it cannot be justified by a surface`,
      };
    }
    if (EFFECT_RANK[effect] > ceiling) {
      return {
        ok: false,
        spec,
        reason:
          `scope "${scope}" carries ${effect} authority, which exceeds the ${highestEffect(granted)} ` +
          `this surface was granted. The binding for ${granted.get(capabilityForScope(scope))?.capability ?? "a capability"} ` +
          `claims a narrower scope than it actually asks for.`,
      };
    }
  }

  return { ok: true, spec };
}

function highestEffect(granted: Map<CapabilityId, Grant>): Effect {
  let highest: Effect = "read";
  for (const grant of granted.values()) {
    if (EFFECT_RANK[grant.risk === "high" ? "admin" : grant.risk === "medium" ? "write" : "read"] >
        EFFECT_RANK[highest]) {
      highest = grant.risk === "high" ? "admin" : grant.risk === "medium" ? "write" : "read";
    }
  }
  return highest;
}

function capabilityForScope(scope: string): CapabilityId {
  return CAPABILITY_BINDINGS.find((b) => b.scopes.includes(scope))?.capability ?? "unknown";
}

/**
 * What this module needs from a token service. Deliberately tiny: mint a
 * token for an exact set of scopes, or refuse.
 *
 * The absence of anything else — no refresh, no upgrade, no "also give me"
 * — is the enforcement. A token service that could widen a request would
 * undo every guarantee above it, so the interface does not offer the
 * ability and no implementation can be asked for it.
 */
export type TokenService = {
  mint(input: { sessionId: string; scopes: string[] }): Promise<{ token: string; scopes: string[] }>;
};
