import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* =============================================================================
   Broker core — the authorization decisions, with no transport
   -----------------------------------------------------------------------------
   Plain JS on purpose. The broker runs as its own process (broker-server.mjs)
   and is imported directly by the tests without a build step, exactly as
   worker.mjs is. The two processes it separates are the web tier that parses
   untrusted HTTP and the component that holds credentials, and that
   separation is the reason this file exists outside the server.

   The property this module exists to prove is narrow and specific:

       A capability revoked at epoch N+1 stops working at epoch N+1.

   Not "stops working when the token expires". That is the whole reason an
   epoch exists, and it is the assertion worth having, because a revoke that
   waits on a TTL is a revoke that has not happened yet.
   ========================================================================== */

const EFFECTS = { read: 0, write: 1, delete: 2, admin: 3 };

function effectOf(risk) {
  if (risk === "high") return "admin";
  if (risk === "medium") return "write";
  return "read";
}

/** Constant-time, and length-safe. A length mismatch is a mismatch, not a
 *  shorter comparison that leaks how much of a forged token was right. */
function verify(secret, sessionId, epoch, signature) {
  const expected = createHmac("sha256", secret).update(`${sessionId}.${epoch}`).digest();
  let given;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export function createBroker(options = {}) {
  const secret = options.secret ?? randomBytes(32).toString("hex");

  /* sessionId → { epoch, capabilities: Set, grants: Map, scopes: Set } */
  const sessions = new Map();

  const sign = (sessionId, epoch) =>
    createHmac("sha256", secret).update(`${sessionId}.${epoch}`).digest("hex");

  return {
    /**
     * Create a session, or return the existing one untouched.
     *
     * Re-opening is not a reset. A caller that opens a session it already
     * has must not be able to clear a revoke by asking again, so the
     * existing epoch stands and the caller is told so.
     */
    openSession({ sessionId, grants = {}, scopes = [], actionToCapability = {} }) {
      const existing = sessions.get(sessionId);
      if (existing) {
        return { ok: true, sessionId, epoch: existing.epoch, reused: true };
      }

      /* The capability set is derived from what was actually granted, not
         passed in separately. Two sources of truth is one too many: a
         caller that sent an action mapping and a capability list that
         disagreed would be accepted by one check and refused by the other,
         and the version of that bug which grants is the one that matters.
         Deriving it here means the two cannot disagree. */
      const capabilities = new Set(Object.values(actionToCapability));

      sessions.set(sessionId, {
        epoch: 1,
        capabilities,
        grants: new Map(Object.entries(grants)),
        actionToCapability: new Map(Object.entries(actionToCapability)),
        scopes: new Set(scopes),
      });
      return { ok: true, sessionId, epoch: 1, reused: false };
    },

    /**
     * Add or remove capabilities, and advance the epoch.
     *
     * Both directions advance it, and that symmetry is the point. A revoke
     * that left the epoch alone would be a revoke that did nothing until
     * every outstanding token happened to expire, which is a no-op wearing a
     * log line that says it worked.
     */
    rotate(sessionId, { grant, revoke, scopes } = {}) {
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: `unknown session ${sessionId}` };

      if (grant) {
        if (grant.capability) session.capabilities.add(grant.capability);
        for (const [action, capability] of Object.entries(grant.actionToCapability ?? {})) {
          session.actionToCapability.set(action, capability);
        }
        for (const [action, g] of Object.entries(grant.grants ?? {})) {
          session.grants.set(action, g);
        }
      }
      if (revoke) {
        if (revoke.capability) session.capabilities.delete(revoke.capability);
        for (const action of revoke.actions ?? []) {
          session.actionToCapability.delete(action);
          session.grants.delete(action);
        }
      }
      if (scopes) session.scopes = new Set(scopes);

      session.epoch += 1;
      return { ok: true, sessionId, epoch: session.epoch };
    },

    epochOf(sessionId) {
      return sessions.get(sessionId)?.epoch ?? null;
    },

    /** A channel token for the session's *current* epoch. It is not a
     *  service credential: it can only ask this broker questions, and only
     *  as this session. */
    mint(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, reason: `unknown session ${sessionId}` };
      return {
        ok: true,
        sessionId,
        epoch: session.epoch,
        token: `${sessionId}.${session.epoch}.${sign(sessionId, session.epoch)}`,
      };
    },

    /**
     * The four checks, in order, and the first failure is the answer.
     *
     * Order matters more than it looks. An expired epoch is reported as a
     * stale epoch rather than as a permission failure, because "you need a
     * new token" and "you may never do this" call for completely different
     * responses from whoever is holding the other end, and collapsing them
     * would make a revoke indistinguishable from a policy decision.
     */
    authorize({ token, action, resource }) {
      if (typeof token !== "string") {
        return { allowed: false, code: "unauthenticated", reason: "no channel token was presented" };
      }
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { allowed: false, code: "unauthenticated", reason: "the channel token is malformed" };
      }
      const [sessionId, epochText, signature] = parts;
      const epoch = Number(epochText);
      if (!Number.isInteger(epoch)) {
        return { allowed: false, code: "unauthenticated", reason: "the channel token carries no epoch" };
      }
      if (!verify(secret, sessionId, epoch, signature)) {
        return { allowed: false, code: "unauthenticated", reason: "the channel token is not valid for this broker" };
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return { allowed: false, code: "unknown_session", reason: `session ${sessionId} is not open` };
      }

      /* The revoke check, and the reason for the epoch's existence. */
      if (epoch !== session.epoch) {
        return {
          allowed: false,
          code: "stale_epoch",
          reason:
            `this token is epoch ${epoch} and the session is now epoch ${session.epoch}. ` +
            `The session changed after the token was issued, which is what revocation and escalation both look like.`,
        };
      }

      const capability = session.actionToCapability.get(action);
      if (!capability || !session.capabilities.has(capability)) {
        return {
          allowed: false,
          code: "not_granted",
          reason: `"${action}" is not granted to this session (held: ${[...session.capabilities].sort().join(", ") || "nothing"})`,
        };
      }

      if (resource !== undefined && resource !== null && session.scopes.size > 0) {
        const inScope = [...session.scopes].some((s) => {
          const r = String(resource);
          return s === "*" || r === s || r.startsWith(s.endsWith("/") ? s : `${s}/`);
        });
        if (!inScope) {
          return {
            allowed: false,
            code: "out_of_scope",
            reason: `"${resource}" is outside every scope granted to this session`,
          };
        }
      }

      return {
        allowed: true,
        capability,
        epoch,
        /* Recorded so the evidence ledger can say what was actually
           exercised, not merely that something was. */
        authorization: {
          sessionId,
          action,
          resource: resource ?? null,
          capability,
          epoch,
        },
      };
    },

    /** For tests and diagnostics. Never returns a token. */
    inspect(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return {
        epoch: s.epoch,
        capabilities: [...s.capabilities].sort(),
        actions: [...s.actionToCapability.keys()].sort(),
        scopes: [...s.scopes].sort(),
      };
    },

    /** The capability ceiling, recomputed on demand. An effect check would
     *  belong here if the broker also signed requests; today it authorizes
     *  and the downscoper decides scope, and this is stated so the gap is
     *  not mistaken for a covered case. */
    effectCeiling(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return 0;
      let highest = 0;
      for (const action of s.actionToCapability.keys()) {
        const grant = s.grants.get(action);
        if (grant) highest = Math.max(highest, EFFECTS[effectOf(grant.risk)] ?? 0);
      }
      return highest;
    },
  };
}
