/**
 * Token scopes — what we ask a credential service for.
 *
 * The assertion in this file is on OUR side of the wire. A fake token
 * service records the exact scope list it was handed, and the tests check
 * that list. Checking instead that a real provider rejects an over-scoped
 * token would validate their infrastructure rather than this codebase: if
 * they regressed the test would go red and teach us nothing, and if we
 * loosened our own mapping their check would mask it and we would go green
 * while the system was wrong.
 *
 * The central case is `.../auth/drive`. It reads like "drive", it is what a
 * plausible mapping reaches for, and it is account-wide read/write/delete.
 * Requesting it for a read-only task succeeds and hands over the lot. So
 * the direction of each scope is recorded independently of the binding that
 * uses it, and every emitted scope is checked against what the surface
 * actually granted.
 */
import { ToolRegistry, resolveSurface } from "../.test-build-workspace/capabilities.js";
import {
  resolveTokenSpec,
  CAPABILITY_BINDINGS,
} from "../.test-build-workspace/token-scope.js";

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

const G = "https://www.googleapis.com/auth/";

/* A registry whose risk levels and scopes match the real profile shape, so
   the downscoper is exercised against realistic inputs rather than a
   convenient one. */
const registry = new ToolRegistry()
  .register({
    id: "local",
    grants: [
      { action: "read_file", capability: "workspace.read", scopes: [], risk: "low", requiresApproval: false, requiresToken: false },
      { action: "write_file", capability: "workspace.write", scopes: [], risk: "low", requiresApproval: false, requiresToken: false },
    ],
  })
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
      { action: "mail.send", capability: "mail.write", scopes: ["account:primary"], risk: "high", requiresApproval: true },
    ],
  })
  .register({
    id: "calendar",
    grants: [
      { action: "calendar.read", capability: "calendar.read", scopes: ["account:primary"], risk: "low", requiresApproval: false },
      { action: "calendar.write", capability: "calendar.write", scopes: ["account:primary"], risk: "medium", requiresApproval: true },
    ],
  })
  .register({
    id: "admin",
    // A capability nobody has bound a scope for. Present so "unbound" is a
    // real state rather than a hypothetical one.
    grants: [
      { action: "account.delete", capability: "account.delete", scopes: ["account:primary"], risk: "high", requiresApproval: true },
    ],
  });

const surfaceFor = (needs) => {
  const resolved = resolveSurface({ registry, taskId: "t", needs });
  if (!resolved.ok) throw new Error(`surface did not resolve: ${resolved.reason}`);
  return resolved.surface;
};

/** A token service that records what it was asked for, and nothing else. */
function fakeTokenService() {
  const requests = [];
  return {
    requests,
    async mint(input) {
      requests.push({ ...input, scopes: [...input.scopes].sort() });
      return { token: `issued-for:${[...input.scopes].sort().join(" ")}`, scopes: input.scopes };
    },
  };
}

// ── the narrowest sufficient scope ────────────────────────────────────────
console.log("\n\x1b[1mthe narrowest sufficient scope\x1b[0m");

{
  const spec = resolveTokenSpec(surfaceFor([{ capability: "storage.read" }]));
  check("a read-only task resolves", spec.ok === true, JSON.stringify(spec.spec));

  if (spec.ok) {
    check("and asks for exactly the readonly scope",
      spec.spec.scopes.join(",") === `${G}drive.readonly`, spec.spec.scopes.join(","));
    check("never the account-wide one", spec.spec.scopes.includes(`${G}drive`) === false);
    check("never the write one either", spec.spec.scopes.includes(`${G}drive.file`) === false);
    check("and names the one capability it came from",
      spec.spec.capabilities.join(",") === "storage.read", spec.spec.capabilities.join(","));
    check("with nothing unbound", spec.spec.unbound.length === 0);
  }
}

{
  // The write binding must be per-file, not account-wide. `drive.file` is
  // the narrowest scope that can create a file at all.
  const spec = resolveTokenSpec(surfaceFor([{ capability: "storage.write" }]));
  check("a write task resolves", spec.ok === true);
  if (spec.ok) {
    check("and asks for the per-file scope",
      spec.spec.scopes.join(",") === `${G}drive.file`, spec.spec.scopes.join(","));
    check("not the account-wide one", spec.spec.scopes.includes(`${G}drive`) === false);
  }
}

{
  // `gmail.send` cannot read the mailbox; `gmail.compose` can keep drafts.
  // Send is the narrow one and is what "write mail" should mean.
  const spec = resolveTokenSpec(surfaceFor([{ capability: "mail.write" }]));
  check("mail write asks for send only", spec.ok === true && spec.spec.scopes.includes(`${G}gmail.send`));
  if (spec.ok) {
    check("not compose, which can keep drafts", spec.spec.scopes.includes(`${G}gmail.compose`) === false);
    check("not full mail, which is everything", spec.spec.scopes.includes(`${G}mail`) === false);
  }
}

{
  const spec = resolveTokenSpec(surfaceFor([{ capability: "calendar.write" }]));
  check("calendar write asks for events only", spec.ok === true && spec.spec.scopes.includes(`${G}calendar.events`));
  if (spec.ok) {
    check("not the full calendar scope, which reaches settings",
      spec.spec.scopes.includes(`${G}calendar`) === false);
  }
}

// ── several capabilities compose ──────────────────────────────────────────
console.log("\n\x1b[1mcomposition\x1b[0m");

{
  const spec = resolveTokenSpec(
    surfaceFor([{ capability: "mail.read" }, { capability: "calendar.read" }, { capability: "storage.read" }]),
  );
  check("a read-everything task resolves", spec.ok === true);
  if (spec.ok) {
    check("with three scopes", spec.spec.scopes.length === 3, spec.spec.scopes.join(","));
    check("all of them readonly",
      spec.spec.scopes.every((s) => s.endsWith("readonly")), spec.spec.scopes.join(","));
    check("and no write or admin scope among them",
      spec.spec.scopes.some((s) => s === `${G}drive` || s === `${G}drive.file` || s === `${G}mail`) === false);
    check("sorted, so two identical surfaces give byte-equal specs",
      spec.spec.scopes.join(",") === [...spec.spec.scopes].sort().join(","));
  }
}

{
  // Read and write together must not collapse into the broad scope. The
  // union of two narrow scopes is still two narrow scopes.
  const spec = resolveTokenSpec(
    surfaceFor([{ capability: "storage.read" }, { capability: "storage.write" }]),
  );
  check("read plus write resolves", spec.ok === true);
  if (spec.ok) {
    check("as two scopes, not one broad one", spec.spec.scopes.length === 2, spec.spec.scopes.join(","));
    check("and the account-wide scope is still absent",
      spec.spec.scopes.includes(`${G}drive`) === false);
  }
}

{
  // A capability needing a token with no binding must be unavailable. The
  // failure mode being avoided is "granted the widest scope so the feature
  // works", which is the exact problem this work exists to remove.
  const spec = resolveTokenSpec(surfaceFor([{ capability: "account.delete" }]));
  check("an unbound capability does not resolve", spec.ok === false);
  check("and says it is unavailable rather than broad",
    spec.ok === false && /unavailable rather than granted a broad scope/.test(spec.reason), spec.reason);
  check("with no scope emitted at all", spec.ok === false && spec.spec.scopes.length === 0, JSON.stringify(spec.spec.scopes));
}

{
  // Partial: the bound capability still works and the unbound one is
  // reported, rather than the whole request failing or silently succeeding.
  const spec = resolveTokenSpec(
    surfaceFor([{ capability: "mail.read" }, { capability: "account.delete" }]),
  );
  check("a partly-bound surface still resolves", spec.ok === true, spec.ok === false ? spec.reason : "");
  if (spec.ok) {
    check("emitting only the bound capability",
      spec.spec.scopes.join(",") === `${G}gmail.readonly`, spec.spec.scopes.join(","));
    check("and reporting the unbound one", spec.spec.unbound.length === 1);
    check("naming it", spec.spec.unbound[0].capability === "account.delete");
  }
}

// ── local capabilities need no credential ─────────────────────────────────
console.log("\n\x1b[1mnot every capability needs a secret\x1b[0m");

{
  const spec = resolveTokenSpec(surfaceFor([{ capability: "workspace.write" }]));
  check("a local-only surface needs no credential", spec.ok === false);
  check("and says so as a fact, not as a failure",
    spec.ok === false && /needs no credential at all/.test(spec.reason), spec.reason);
  check("with no scopes requested", spec.ok === false && spec.spec.scopes.length === 0);

  const mixed = resolveTokenSpec(
    surfaceFor([{ capability: "workspace.write" }, { capability: "mail.read" }]),
  );
  check("local plus remote resolves on the remote one alone", mixed.ok === true);
  if (mixed.ok) {
    check("and the local capability contributes no scope",
      mixed.spec.scopes.join(",") === `${G}gmail.readonly`, mixed.spec.scopes.join(","));
  }
}

// ── the safety net: a mis-authored binding cannot over-grant ─────────────
console.log("\n\x1b[1ma binding cannot grant more than the surface justified\x1b[0m");

{
  /* Re-author a binding to claim `.../drive` for a read-only capability —
     the plausible mistake, and a working token in production. The effect
     check reads the scope's true authority from the independent table, so
     the claim does not survive it. */
  const binding = CAPABILITY_BINDINGS.find((b) => b.capability === "storage.read");
  const original = [...binding.scopes];
  binding.scopes = [`${G}drive`];

  const spec = resolveTokenSpec(surfaceFor([{ capability: "storage.read" }]));
  check("an over-broad binding is refused", spec.ok === false, JSON.stringify(spec.spec?.scopes));
  check("naming what the scope actually carries",
    spec.ok === false && /carries admin authority/.test(spec.reason), spec.reason);
  check("and naming the ceiling it exceeded",
    spec.ok === false && /exceeds the (read|write|admin)/.test(spec.reason), spec.reason);

  binding.scopes = original;
  const restored = resolveTokenSpec(surfaceFor([{ capability: "storage.read" }]));
  check("restoring the binding restores the narrow spec",
    restored.ok === true && restored.spec.scopes.join(",") === `${G}drive.readonly`);
}

{
  // An unknown scope is refused rather than requested. A scope nobody has
  // characterised has unknown reach, and unknown reach cannot be justified.
  const binding = CAPABILITY_BINDINGS.find((b) => b.capability === "mail.read");
  const original = [...binding.scopes];
  binding.scopes = ["https://example.com/auth/something-unreviewed"];

  const spec = resolveTokenSpec(surfaceFor([{ capability: "mail.read" }]));
  check("a scope with no recorded effect is refused", spec.ok === false);
  check("saying its reach is unknown",
    spec.ok === false && /reach is unknown/.test(spec.reason), spec.reason);

  binding.scopes = original;
}

// ── asserting on what we ask for ──────────────────────────────────────────
console.log("\n\x1b[1mwhat the token service is actually handed\x1b[0m");

{
  const service = fakeTokenService();

  const readOnly = resolveTokenSpec(surfaceFor([{ capability: "storage.read" }]));
  if (readOnly.ok) {
    await service.mint({ sessionId: "s-1", scopes: readOnly.spec.scopes });
  }

  check("the service was asked exactly once", service.requests.length === 1);
  const asked = service.requests[0];
  check("for the readonly scope", asked.scopes.join(",") === `${G}drive.readonly`, asked.scopes.join(","));
  check("and for nothing else", asked.scopes.length === 1);
  check("the account-wide scope was never requested", asked.scopes.includes(`${G}drive`) === false);

  /* The property the whole module is for, stated as one line: what leaves
     this system is the narrowest thing that satisfies the task. A test that
     asserted on the token service's response instead would be asserting on
     theirs. */
  const emitted = service.requests.flatMap((r) => r.scopes);
  check("no scope emitted anywhere is account-wide",
    emitted.every((s) => s !== `${G}drive` && s !== `${G}mail` && s !== `${G}calendar`),
    emitted.join(","));
  check("no scope emitted anywhere is a full-service scope",
    emitted.every((s) => !s.endsWith("/auth/drive") || s.includes("readonly") || s.includes("file")));
}

{
  // No wildcard exists. A caller who wants everything must name every
  // capability, and each is checked on its own.
  const surface = surfaceFor([
    { capability: "storage.read" },
    { capability: "mail.read" },
    { capability: "calendar.read" },
  ]);
  const spec = resolveTokenSpec(surface);
  check("a three-capability surface yields three scopes", spec.ok === true && spec.spec.scopes.length === 3);
  check("the binding table itself has no catch-all entry",
    CAPABILITY_BINDINGS.every((b) => Array.isArray(b.scopes) && b.scopes.length > 0));
  check("and no binding claims a full-service scope",
    CAPABILITY_BINDINGS.every((b) => b.scopes.every((s) => s.endsWith("readonly") || s.endsWith("send") || s.endsWith("events") || s.endsWith("file"))),
    CAPABILITY_BINDINGS.flatMap((b) => b.scopes).join(","));
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
