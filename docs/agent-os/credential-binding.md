# Credential Binding — proposed contract

**Status: FOR REVIEW. Not implemented. No code in this repository depends on
anything below.**

The ask was to review the scheme and tighten it before execution. This
document is the scheme. Where I disagree with the proposed ordering or with a
proposed test, I say so in place rather than in a footnote.

---

## 0. The thing that has to come first, which is not a credential

`apps/command-center/app/lib/isolated-executor.ts:173`

```ts
env: { ...process.env, NODE_ENV: "production" },
```

The executor passes the **entire parent environment** to every child process.

This is ambient authority, present today, in the shipped code. Concretely: if
`GOOGLE_OAUTH_TOKEN` is in the server's environment, then every child the
executor spawns has it — for every task, for every capability set, including
a surface that grants `workspace.write` and nothing else.

The consequence is worth stating plainly because it undercuts a conclusion one
might otherwise draw from the last commit:

> The capability layer is currently **decorative against the credential threat**.
> The 567 tests pass, the surface works, and a task with no `mail` capability
> still has a mail token in its environment if the operator put one there.

The capability layer solves *"the plan names a tool the task was not given."*
It does not solve *"the process holds a credential nobody granted it."* Those
are different attacks, and only the first is closed today.

**Therefore Layer 0 is env hygiene, and it is a prerequisite for both proposed
models.** You cannot downscope credentials you are still broadcasting to every
child, and you cannot claim "zero secrets in worker" while the worker reads
`process.env`.

Layer 0 is small, testable today, and independent of the auth design. I
recommend landing it as its own commit before any of the below is discussed
further, because it is worth having even if the broker model is rejected.

```ts
// The child gets a constructed environment, not an inherited one.
env: {
  PATH: "/usr/bin:/bin",
  NODE_ENV: "production",
  // The only task-scoped value, and it is a broker channel token, not a
  // service credential. See Layer 1.
  CELESTYLE_BROKER_SOCKET: socketPath,
  CELESTYLE_CHANNEL_TOKEN: channelToken,
}
```

Test: spawn a worker, have it dump `process.env`, assert no key matches
`/TOKEN|SECRET|KEY|CREDENTIAL|PASSWORD/` and that the count is ≤ 4. That test
fails today and passes after. It is the cheapest high-value assertion in this
whole document.

---

## 1. On the two models

I recommend **Model 2 (Broker) as the default**, with Model 1 admitted only
where a broker is structurally impossible. The reasoning is one property:

> A credential in the child's memory is a credential that can be read, logged,
> core-dumped, echoed in an error message, or exfiltrated. Short expiry
> shrinks the window. It does not close it.

Model 1's real weakness is not the token's lifetime, it is **where the token
lives**. A downscoped token injected into the worker is still a bearer token in
a process whose entire design assumption is "this process might be hostile." We
built this system on the assumption that the tool is untrusted — bounded
output, hard timeouts, realpath confinement, a child process precisely so a
crash or a bug in the tool does not reach the kernel. Injecting a live
credential into that process takes the one asset the design was protecting and
places it in the blast radius.

Model 2's cost is a network hop and an operational dependency. That is a real
cost and I am not pretending otherwise. But it is a cost paid *outside* the
threat boundary, which is exactly where costs belong.

| | Model 1: Downscoped injection | Model 2: Broker |
|---|---|---|
| Token in worker | Yes, short-lived | **No** |
| Stolen token useful for | That capability, until expiry | Nothing outside the broker, for that session |
| Leak vector | env, `/proc/PID/environ`, logs, crash dump, error text | None — the worker has no service credential to leak |
| Blast radius of a compromised child | The granted capability, bounded by TTL | A broker channel for one session, revocable instantly |
| Works with an SDK that insists on a raw token | Yes | **No — this is the fallback case** |

**The honest counter-argument to my recommendation:** a broker that is itself
remote (a hosted token service) reintroduces the problem one hop out, and a
local broker is a new privileged process that must itself be trustworthy. A
local broker is a much smaller thing to trust than a shared token handed to
every task, but it is not nothing, and it should be stated in the threat model
rather than assumed away.

---

## 2. Layering

```
L0  env hygiene              the child inherits nothing        ← PREREQUISITE
L1  channel token             broker-facing, not service-facing
L2  broker                    holds service credentials, downscoped
L3  per-request authorization surface re-checked at request time
```

### L1 — Channel token

What authenticates the child to the broker. It is **not** a Google credential.
It is scoped to: one session, one surface epoch, the broker only.

- Rotating, short-lived, single-session.
- **Bound to a surface epoch.** A capability granted or revoked mid-run
  changes the epoch; a channel token minted against epoch *n* is refused by
  epoch *n+1*. Without this, revoking a capability has no effect on in-flight
  sessions until they expire, which is the ambient-authority problem wearing a
  shorter TTL.
- Carries no service identity. Stealing it yields "you may ask the broker
  things as this session", which the broker then re-authorizes per request.

Where it lives: child `env` is acceptable *because* it is broker-scoped, and
because L0 guarantees it is the only secret in there. On Linux, prefer a unix
domain socket with `SO_PEERCRED` peer credentials, which needs no secret at
all; fall back to the token where that is unavailable.

### L2 — Broker

Holds the real credentials. For each session it exchanges the operator's
master token for a **downscoped** token covering exactly the surface's
capabilities (RFC 8693 token exchange, or Google-native equivalents). A
`drive.read`-only surface yields a `drive.readonly` token and nothing else.

The broker holds the downscoped token. The worker never sees it, in any form,
at any point — not in env, not in argv, not in a response body, not in an
error message.

**Every broker call is an evidence event.** A request, its authorization
decision, and its outcome get a ledger entry. This is the point where
credential use becomes auditable rather than inferred, and it closes the loop
back to the Evidence Ledger the rest of the system already maintains.

### L3 — Per-request authorization

On every request the broker re-checks, against the **current** surface and
epoch:

1. Is the session live?
2. Is the epoch current?
3. Does the surface grant this **action** on this **resource**?
4. Is the resource inside the action's **scope**?

Any `no` refuses. The broker does not trust the worker's claim about which
capability it is exercising, and it does not cache decisions across epochs.

---

## 3. Proposed contract

```ts
/** What a tool must be able to do without holding a credential. */
export type BrokerRequest = {
  requestId: string;
  epoch: number;              // must match the broker's current epoch
  action: ToolId;             // e.g. "storage.read"
  resource: string;           // path, URL, or resource id
  params?: Record<string, unknown>;
};

export type AuthorizationDecision =
  | { allowed: true;  capability: CapabilityId; scope: string; evidence: EvidenceRef }
  | { allowed: false; code: AuthorizationCode; reason: string };

export type AuthorizationCode =
  | "unknown_session"
  | "stale_epoch"          // a grant or revocation happened; token is void
  | "not_granted"         // the surface does not hold this action
  | "out_of_scope"        // the action is granted, but not for this resource
  | "policy_refused";     // the policy engine said no for this plan

export interface CredentialBinder {
  /** Host-side. Exchanges operator credentials for surface-scoped ones. */
  mintChannelToken(input: { sessionId: string; epoch: number }): Promise<ChannelToken>;
  /** Host-side. Advances the epoch, voiding every outstanding token. */
  rotateEpoch(sessionId: string): Promise<number>;
  /** L3. Called on every broker request. */
  authorize(request: BrokerRequest): Promise<AuthorizationDecision>;
}
```

The worker gains one new message type. Today `worker.mjs` dispatches on
`action` and does the work itself. With a broker it gains:

```json
{ "action": "invoke", "payload": { "requestId": "...", "epoch": 3, "action": "storage.read", "resource": "..." } }
```

`invoke` goes over the channel to the broker. The worker never holds a service
credential, which is the property the whole design is buying.

---

## 4. Invariants

Stated so each is independently testable, and so a future reader can tell
whether the system still satisfies them.

```
I1  A worker process holds no service credential at any point.
I2  A child process's environment contains no inherited secret.
I3  A capability absent from the surface cannot be exercised, even by a
    worker that asks for it directly and even with a valid channel token.
I4  A scope present in a grant but absent from the request is refused.
I5  Revoking or granting a capability takes effect on the next request
    without waiting for any token to expire.
I6  Every exercised capability produces a ledger entry naming the
    capability, the resource and the decision.
I7  A worker cannot widen its own scope by describing it more precisely.
```

I7 is the one most likely to be violated by a well-meaning implementation: an
endpoint that accepts a caller-supplied scope and merges it into the grant
would satisfy every other invariant while defeating the point.

---

## 5. What the tests must prove — and one that must not be written

**The proposal asks for a test that the child is refused by the credential
server when it presents a scope beyond what was requested.** I recommend
against that test, for the same reason I have rejected mock-based assertions
throughout this project: it would test *Google's* implementation. Whether
Google rejects an over-scoped token is Google's guarantee, not a property of
ours. If they regress, our test goes red and we learn nothing about our code;
if we loosen our own downscoping and Google's check masks it, we go green while
the system is wrong.

The assertions that test *our* code:

| Test | Proves |
|---|---|
| Worker env contains no secret (L0) | I2 |
| Worker cannot read any service credential from memory, env or argv | I1 |
| Broker refuses `storage.write` for a `storage.read` session | I3 |
| Broker refuses a resource outside the granted scope | I4 |
| Revoking a capability, then requesting it, is refused **immediately** | I5 |
| Every broker call produced exactly one ledger entry, decision included | I6 |
| Requesting a wider scope does not widen the grant | I7 |
| A stolen channel token yields broker access for one session, and no service token | L1 |

The scope test we should write is the inverse of the proposed one: assert that
**the token we mint is the narrowest one that satisfies the surface**, by
asserting on *what we asked the token service for*. That tests our downscoping
logic, which is our code.

---

## 6. What this does not fix

Stated before implementation rather than discovered after, because these are
the limits people will otherwise assume are covered.

- **It does not stop exfiltration of data the child can already read.** A
  worker with `workspace.read` can read a file and `POST` it to any host it
  can reach, with no credential at all. The broker prevents *ambient
  authority*; it does not prevent *data leaving*. The complement is network
  egress control — a network namespace or seccomp filter — and that is
  explicitly out of scope here. Anyone who tells you token scoping solves
  exfiltration is wrong.
- **It does not make the child process safe.** Same boundary as the executor:
  fault and resource isolation, not a kernel sandbox. A malicious tool can
  still consume CPU, and with L0 it can still open network connections to any
  reachable host.
- **It does not solve TOCTOU between plan and request.** L3 narrows this to
  the request window; it does not make a plan atomic with its execution.
- **It does not make the broker free.** A local broker is a new privileged
  process. It must be small, single-purpose, and itself the thing we are least
  willing to compromise.
- **Downscoping depends on the upstream service supporting it.** If a provider
  offers no narrow scope for a capability, the honest outcome is that the
  capability is unavailable in broker mode, not that we fall back to a wide
  token.

---

## 7. Recommended sequence

Ordered so that each step is useful even if the next is never approved.

1. **L0 env hygiene.** Small, uncontroversial, fixes a live hole. Ship alone.
2. **The scope-downscoping function**, tested against a fake token service.
   Pure logic: `(surface) → requested scopes`. No broker yet.
3. **L1 channel token + epoch**, with a broker that authorizes against a
   surface and makes no real network calls. This is where I5 becomes provable.
4. **L2 broker against one real service**, one capability, read-only.
5. **L3 resource-scope checks**, once there is a resource to be out of scope of.
6. **OAuth bindings** — `storage.read` → `drive.readonly` — as data, reviewed
   per capability.

Steps 2 and 3 are the ones that should be agreed before 4 happens, because 4
is the first step where a real credential is in the loop and the first step
where a mistake has consequences outside this repository.

---

## 8. Decisions

1. **Broker or injection?** Broker. Injection is a fallback for SDKs that
   insist on a raw token, and any capability using it is listed explicitly as
   an exception with a reason rather than treated as a default. — *agreed,
   and now written into the module as the reason Broker is the default.*
2. **Which service first?** Read-only. `storage.read` is already in the
   registry and a read-only mistake is recoverable. — *settled; the first
   binding in `token-scope.ts` is `storage.read`.*
3. **In-process, sidecar, or separate service?** **Undecided, and still
   open.** It decides the trust boundary. Steps 1–3 of the sequence do not
   depend on it, which is why it has not blocked anything so far. It must be
   answered before L2.
4. **A capability with no downscoped equivalent?** It becomes **unavailable**.
   The alternative — issuing a broad token so the feature works — recreates
   the problem this work removes, and does it invisibly. — *settled and
   enforced: `resolveTokenSpec` refuses unbound capabilities rather than
   falling back, and the test for that guard was checked by replacing the
   guard with exactly that fallback.*
5. **Epoch semantics?** Both grant and revoke advance it. A revoke that does
   not advance the epoch is a no-op with a reassuring log message. — *still
   unbuilt; this is the substance of step 3.*

---

## 9. Progress

**L0 — done** (`707c4dc`). The child gets a constructed environment. The
negative run showed 22 variables reaching a worker granted two, including
`GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` in plaintext.

**Scope downscoping — done.** `token-scope.ts` maps a surface to the exact
OAuth scope list a credential must carry.

The design decision that matters is that a scope's *effect* is recorded
independently of the binding that uses it. If a binding also declared its own
scope's effect, the check would be comparing a claim against itself, and a
mis-authored binding would pass. As written, a binding that maps
`storage.read` to `.../auth/drive` is refused before a token service is
contacted — verified by disabling the ceiling, at which point the
account-wide scope is emitted and three assertions catch it.

`.../auth/drive` is the specific case. It reads like "drive", it is what a
plausible mapping reaches for, and it is account-wide read/write/delete. A
read-only task requesting it gets a working token and the lot.

Tokens are distinguished from capabilities that need none: `requiresToken`
defaults to true, so a forgotten binding and a genuinely local capability
cannot look alike.

## 10. L1 — the broker, as built

The broker is a separate program, not a module. `broker-server.mjs` owns the
secret; `credential-broker.ts` is the web tier's client and can hold nothing.
The web tier parses untrusted request bodies with `JSON.parse`, and a process
that both parses attacker-shaped input and holds service credentials is one
compromise away from having both.

**The property.** A capability revoked at epoch N+1 is refused at epoch N+1.
The test revokes `storage.write`, keeps the identical token, and gets a
refusal — same token bytes, no expiry, no timeout, no recall. TTL is
containment for a broker that is unreachable; the epoch is what makes
revocation mean something while it is running.

**A stale token must be distinguishable from a policy refusal.** Five codes:
`unauthenticated`, `unknown_session`, `stale_epoch`, `not_granted`,
`out_of_scope`. A revoked token reports `stale_epoch` and a never-granted
capability reports `not_granted`. Collapsing them would be worse than either:
`not_granted` is an argument a caller can make in a later request, while
`stale_epoch` means the session moved and the token described a world that no
longer exists. That distinction is what the epoch-mutation test protects — with
the check disabled the same refusal arrives as `not_granted`, five assertions
fail, and the system is still *safe* but has stopped being *revocable*.

**Grant advances the epoch too.** Otherwise a token minted before a capability
arrived could not exercise it, escalation would silently not work, and the
temptation would be to stop checking the epoch on the way up. The tests assert
the symmetric case: a grant makes the prior token stale as well.

**Re-opening is not a reset.** `openSession` returns `reused: true` for a
known session and does not restore anything, or a client could clear a revoke
by asking politely. The epoch never moves backwards.

**Capabilities are derived, not declared.** `openSession` builds the
capability set from the action mapping it was given rather than accepting a
second, parallel list. Two sources of truth is one too many, and the failure
that matters is the one where they disagree in the permissive direction. This
was a real bug, not a hypothetical: the first implementation left the set
empty and every session granted nothing, which is safe and completely broken.
Only the tests that assert granted actions *work* caught it — a suite that
only checked refusals would have passed it.

**The socket is 0600 in a 0700 directory.** A broker socket anyone local can
reach is a broker whose isolation is decorative. The mode is asserted against
the real socket, and 0666 fails the suite.

**`inspect` never returns a token.** Diagnostics need session state, not
bearer material; a debug endpoint that prints live tokens is a credential
store with extra steps.

**The secret moves by environment, not argv.** argv is world-readable through
`/proc`. It is generated per broker and never persisted — a broker that
reloaded its state from a file on startup would be a broker with a secret at
rest, so restart voids every session, which is the correct failure mode.

**What the worker gets.** `CELESTYLE_BROKER_SOCKET` and
`CELESTYLE_CHANNEL_TOKEN` — an address and a capability, neither spendable. The
token names a session and epoch; it cannot be exchanged for a credential,
because the broker never releases credentials to anyone. `BROKER_SCOPED_KEYS`
is no longer empty, and each value is shape-checked before it crosses, so a
truncated or substituted token surfaces at the boundary rather than as a
confusing rejection later.

### Known gap

The signature comparison is `timingSafeEqual`. Replacing it with `===`
causes **zero** test failures, and that is expected: a timing difference is
not observable from a functional test. Recorded here rather than papered over
with a source-grep test, which would assert that a string is present and call
it coverage. If a non-constant-time comparison ever mattered, it would need a
statistical test with a stated threshold, and the threshold would be a
judgement about the attacker rather than about the code.

### Still not done

L2 (per-request authorization) and L3 (real service binding) are untouched.
The broker proves the channel and the epoch; it has never spoken to a
provider, and the first live integration stays blocked until the contract in
§3 is reviewed.
