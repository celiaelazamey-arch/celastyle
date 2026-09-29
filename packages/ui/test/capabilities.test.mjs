/**
 * Capabilities — the registry, the task-scoped surface, and just-in-time
 * grants.
 *
 * The property under test throughout is absence, not refusal. A refused tool
 * is a decision that can be mis-wired; a tool that was never in the surface
 * is a fact about what the task was given. These tests hold the difference
 * by checking what the surface *contains*, and separately that the executor
 * declines to spawn a process for anything outside it.
 *
 * The composition cases matter more than the individual ones. A capability
 * that is harmless alone can assemble into something that is not, and no
 * per-capability review catches that — which is the whole reason the policy
 * engine reads a plan rather than a step.
 */
import {
  ToolRegistry,
  resolveSurface,
  extendSurface,
} from "../.test-build-workspace/capabilities.js";
import { buildPlan } from "../.test-build-workspace/planner.js";
import { IsolatedExecutor } from "../.test-build-workspace/isolated-executor.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const root = await mkdtemp(join(tmpdir(), "caps-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });

/* A registry shaped like the real thing: several services, each with
   read and write capabilities at different risk. gmail and calendar are the
   ones a scheduling task would plausibly need; drive, photos and youtube
   are registered too, precisely so that "not granted" is a real state
   rather than a hypothetical one. */
const registry = new ToolRegistry()
  .register({
    id: "gmail",
    grants: [
      { action: "gmail.read", capability: "mail.read", scopes: ["account:primary"], risk: "low", requiresApproval: false, estimatedCost: 1 },
      { action: "gmail.send", capability: "mail.write", scopes: ["account:primary"], risk: "high", requiresApproval: true, estimatedCost: 5 },
    ],
  })
  .register({
    id: "calendar",
    grants: [
      { action: "calendar.read", capability: "calendar.read", scopes: ["account:primary"], risk: "low", requiresApproval: false, estimatedCost: 1 },
      { action: "calendar.write", capability: "calendar.write", scopes: ["account:primary"], risk: "medium", requiresApproval: true, estimatedCost: 3 },
    ],
  })
  .register({
    id: "drive",
    grants: [
      { action: "drive.read", capability: "drive.read", scopes: ["account:primary"], risk: "medium", requiresApproval: false, estimatedCost: 2 },
      { action: "drive.write", capability: "drive.write", scopes: ["account:primary"], risk: "high", requiresApproval: true, estimatedCost: 8 },
    ],
  })
  .register({
    id: "photos",
    grants: [
      { action: "photos.read", capability: "photos.read", scopes: ["account:primary"], risk: "low", requiresApproval: false, estimatedCost: 1 },
    ],
  })
  .register({
    id: "youtube",
    grants: [
      { action: "youtube.upload", capability: "video.upload", scopes: ["account:primary"], risk: "high", requiresApproval: true, estimatedCost: 10 },
    ],
  });

// ── the surface is built from the request, not from the registry ───────────
console.log("\n\x1b[1mthe surface is what the task asked for\x1b[0m");

{
  const { ok, surface, refused } = resolveSurface({
    registry,
    taskId: "schedule-meetings",
    needs: [
      { capability: "mail.read", justification: "find the important messages" },
      { capability: "calendar.read", justification: "see what is booked" },
    ],
  });

  check("a satisfiable request resolves", ok === true, JSON.stringify(refused));
  if (ok) {
    check("and it contains exactly the two requested capabilities",
      surface.capabilities().join(",") === "calendar.read,mail.read", surface.capabilities().join(","));
    check("with no refusals", refused.length === 0);
    check("gmail.read is present", surface.has("gmail.read"));
    check("calendar.read is present", surface.has("calendar.read"));

    /* The absence that matters: these are registered, they exist, and they
       were not requested. A plan naming them is naming something that was
       never on offer — which is a different and stronger statement than
       "permission denied". */
    check("drive.read is NOT in the surface", surface.has("drive.read") === false);
    check("drive.write is NOT in the surface", surface.has("drive.write") === false);
    check("photos.read is NOT in the surface", surface.has("photos.read") === false);
    check("youtube.upload is NOT in the surface", surface.has("youtube.upload") === false);
    check("and mail.write is NOT in the surface", surface.has("gmail.send") === false);
  }
}

{
  /* Wildcards do not exist. There is no call that returns the registry, so
     a newly registered capability is inherited by nobody until a task asks
     for it by name. */
  const empty = resolveSurface({ registry, taskId: "t", needs: [] });
  check("an empty need list yields an empty surface", empty.ok === true);
  if (empty.ok) {
    check("with nothing in it", empty.surface.actions().length === 0, empty.surface.actions().join(","));
  }

  const unknown = resolveSurface({ registry, taskId: "t", needs: [{ capability: "photos.delete" }] });
  check("a capability nobody registers does not resolve", unknown.ok === false);
  check("and says so by name", unknown.ok === false && unknown.refused[0].capability === "photos.delete");

  const allUnknown = resolveSurface({
    registry,
    taskId: "t",
    needs: [{ capability: "nope.a" }, { capability: "nope.b" }],
  });
  check("a task whose every need fails is refused outright", allUnknown.ok === false);
  check("listing every reason", allUnknown.ok === false && allUnknown.refused.length === 2);
}

// ── partial availability is reported, not silently truncated ───────────────
console.log("\n\x1b[1mpartial availability is visible\x1b[0m");

{
  const { ok, surface, refused } = resolveSurface({
    registry,
    taskId: "mixed",
    needs: [
      { capability: "mail.read" },
      { capability: "photos.delete", justification: "tidy up some photos" },
    ],
  });

  /* photos is registered but photos.delete is not a grant it has — the
     distinction between "no such service" and "not that permission on this
     service" is the one a user needs to act on, and both must be reported
     rather than one being silently accepted. */
  check("what is available still resolves", ok === true);
  if (ok) {
    check("containing only what was available",
      surface.capabilities().join(",") === "mail.read", surface.capabilities().join(","));
    check("and the refusal is reported, not swallowed", refused.length === 1, JSON.stringify(refused));
    check("naming the capability that was missing", refused[0].capability === "photos.delete",
      refused[0].capability);
    check("and saying it is not registered", /no registered tool/.test(refused[0].reason), refused[0].reason);
  }
}

// ── narrowing, not naming ──────────────────────────────────────────────────
console.log("\n\x1b[1masking less is possible, asking for more is not\x1b[0m");

{
  // A scope the grant covers.
  const narrow = resolveSurface({
    registry,
    taskId: "narrow",
    needs: [{ capability: "drive.read", scopes: ["account:primary/team"] }],
  });
  check("a sub-scope of a granted scope resolves", narrow.ok === true);
  if (narrow.ok) {
    const grant = narrow.surface.grantFor("drive.read");
    check("and the surface records the REQUESTED scope, not the granted one",
      grant?.scopes.length === 1 && grant.scopes[0] === "account:primary/team",
      JSON.stringify(grant?.scopes));
  }

  // A scope the grant does not cover.
  const outside = resolveSurface({
    registry,
    taskId: "outside",
    needs: [{ capability: "drive.read", scopes: ["account:someone-else"] }],
  });
  check("a scope outside the grant does not resolve", outside.ok === false);
  check("and names the scope that was refused", outside.ok === false && /someone-else/.test(outside.reason), outside.reason);

  const sideways = resolveSurface({
    registry,
    taskId: "sideways",
    needs: [{ capability: "mail.read", scopes: ["account:other"] }],
  });
  check("a sibling scope is refused too", sideways.ok === false);
}

// ── cost ───────────────────────────────────────────────────────────────────
console.log("\n\x1b[1mcost\x1b[0m");

{
  const cheap = resolveSurface({
    registry,
    taskId: "cheap",
    needs: [{ capability: "mail.read" }, { capability: "calendar.read" }],
  });
  check("a cheap surface costs little", cheap.ok === true && cheap.surface.totalCost() === 2, String(cheap.surface?.totalCost()));

  const over = resolveSurface({
    registry,
    taskId: "over",
    needs: [{ capability: "video.upload" }],
    budget: 5,
  });
  check("a surface over budget is refused", over.ok === false);
  check("and the numbers are given", over.ok === false && /10.*budget of 5/.test(over.reason), over.reason);

  const under = resolveSurface({
    registry,
    taskId: "under",
    needs: [{ capability: "video.upload" }],
    budget: 10,
  });
  check("a surface within budget resolves", under.ok === true);
}

// ── the boundary is absence, not refusal ──────────────────────────────────
console.log("\n\x1b[1ma tool outside the surface does not start a process\x1b[0m");

{
  const workerPath = resolve(
    new URL(".", import.meta.url).pathname,
    "../../../apps/command-center/app/lib/tools/worker.mjs",
  );
  const { surface } = resolveSurface({
    registry,
    taskId: "boundary",
    needs: [{ capability: "mail.read" }],
  });

  const executor = new IsolatedExecutor({ workerPath, surface });
  const skill = { name: "s", risk_level: "low", allowed_tools: ["gmail.read"], allowed_directories: [workspace] };

  /* A write action with a path well inside the allowed directory. Every
     path check would pass. The only thing standing in the way is that the
     tool is not in the surface, which is the property being tested. */
  const outcome = await executor.run(
    "write_file",
    { path: join(workspace, "via-ungranted-tool.md"), content: "x" },
    skill,
  );

  check("the ungranted tool is refused", outcome.ok === false, JSON.stringify(outcome));
  check("as a refusal, not a crash", outcome.failure?.kind === "refused", outcome.failure?.kind);
  check("and the reason names the capability set",
    /capability set/.test(outcome.failure?.reason ?? ""), outcome.failure?.reason);
  check("nothing was written", await import("node:fs/promises")
    .then((fs) => fs.stat(join(workspace, "via-ungranted-tool.md")).then(() => false, () => true)));

  // And the granted one still works, so the surface is a real filter and
  // not a blanket denial.
  check("a granted tool is not affected by the boundary", surface.has("gmail.read"));
}

// ── just-in-time extension ─────────────────────────────────────────────────
console.log("\n\x1b[1mjust-in-time capability\x1b[0m");

{
  const { surface } = resolveSurface({
    registry,
    taskId: "jit",
    needs: [{ capability: "mail.read" }],
  });
  const before = surface.actions().slice();

  // A low-risk capability needs no approval.
  const readExtension = await extendSurface({
    surface,
    registry,
    need: { capability: "calendar.read", justification: "also check the calendar" },
  });
  check("a low-risk capability is granted without approval", readExtension.ok === true);
  if (readExtension.ok) {
    check("and is added to the surface", readExtension.surface.has("calendar.read"));
    check("without removing what was there", before.every((a) => readExtension.surface.has(a)));
    check("the original surface is UNCHANGED", surface.has("calendar.read") === false);
  }

  // A high-risk one requires approval, and an absent approver is not consent.
  const noApprover = await extendSurface({
    surface,
    registry,
    need: { capability: "drive.write", justification: "save a copy" },
  });
  check("a high-risk capability with no approver is refused", noApprover.ok === false);
  check("and says approval is what is missing", noApprover.ok === false && noApprover.code === "needs_approval", noApprover.code);

  // An approver that says nothing is not a yes.
  const silent = await extendSurface({
    surface,
    registry,
    need: { capability: "drive.write" },
    approve: () => undefined,
  });
  check("a silent approver is a refusal", silent.ok === false && silent.code === "approval_denied", silent.code);

  const saidNo = await extendSurface({
    surface,
    registry,
    need: { capability: "drive.write" },
    approve: () => false,
  });
  check("an explicit no is a refusal", saidNo.ok === false && saidNo.code === "approval_denied");

  const saidYes = await extendSurface({
    surface,
    registry,
    need: { capability: "drive.write", justification: "approved by a person" },
    approve: () => true,
  });
  check("an explicit yes grants it", saidYes.ok === true);
  if (saidYes.ok) {
    check("and the new surface has it", saidYes.surface.has("drive.write"));
    check("while the old one still does not", surface.has("drive.write") === false);
  }

  // A capability nobody registered cannot be granted by asking nicely.
  const invented = await extendSurface({
    surface,
    registry,
    need: { capability: "photos.delete_everything" },
    approve: () => true,
  });
  check("even with approval, an unregistered capability is not granted", invented.ok === false);
  check("approval cannot conjure a tool", invented.ok === false && invented.code === "unknown");
}

{
  // Widening is a new value, so nothing already run can retroactively become
  // permitted. If this were an in-place mutation, a step that ran under the
  // narrow surface would be indistinguishable from one that ran under the
  // wide one.
  const { surface: narrow } = resolveSurface({
    registry,
    taskId: "immutable",
    needs: [{ capability: "mail.read" }],
  });
  const actionsBefore = narrow.actions().slice();

  const widened = await extendSurface({
    surface: narrow,
    registry,
    need: { capability: "drive.read" },
  });

  check("the extension succeeded", widened.ok === true);
  check("and the old surface still lists exactly what it did",
    narrow.actions().join(",") === actionsBefore.join(","), narrow.actions().join(","));
  check("with no trace of the addition", narrow.has("drive.read") === false);
}

// ── the surface is serialisable evidence ───────────────────────────────────
console.log("\n\x1b[1mwhat the task was given is recordable\x1b[0m");

{
  const { surface } = resolveSurface({
    registry,
    taskId: "evidence",
    needs: [{ capability: "mail.read" }, { capability: "calendar.write" }],
  });
  const json = surface.toJSON();

  check("it serialises to capabilities", json.capabilities.length === 2, JSON.stringify(json));
  check("and to actions", json.actions.includes("calendar.write"));
  check("sorted, so two identical surfaces are byte-identical",
    json.capabilities.join(",") === [...json.capabilities].sort().join(","));
  check("and carries the task it belongs to", json.taskId === "evidence");
  check("the JSON holds no grant internals", JSON.stringify(json).indexOf("requiresApproval") === -1);
}


// ── composition: the risk that lives in the plan, not the step ────────────
console.log("\n\x1b[1mcomposition: reading across services and writing outward\x1b[0m");

{
  const skill = (name) => ({
    name,
    risk_level: "low",
    allowed_tools: ["read", "write"],
    allowed_directories: ["/srv"],
  });
  const node = (id, action, capabilityDir, dependsOn = []) => ({
    id,
    action,
    skill: skill(capabilityDir),
    payload: { path: `${capabilityDir}/${id}` },
    expected: `${capabilityDir}/${id} exists`,
    dependsOn,
  });

  /* The exfiltration shape from the design: read from several services,
     gather them, write the result somewhere else. Every step is permitted
     on its own — the task holds all four capabilities — and the plan is
     still the thing a person should look at. */
  const granted = resolveSurface({
    registry,
    taskId: "gather",
    needs: [
      { capability: "mail.read" },
      { capability: "calendar.read" },
      { capability: "photos.read" },
      { capability: "drive.write" },
    ],
  });
  check("the surface grants all four", granted.ok === true, JSON.stringify(granted.refused));

  if (granted.ok) {
    const plan = buildPlan({
      goal: "collect what is there",
      goalRisk: "high",
      capabilities: granted.surface,
      steps: [
        node("1", "gmail.read", "mail"),
        node("2", "calendar.read", "calendar", ["1"]),
        node("3", "photos.read", "photos", ["2"]),
        node("4", "drive.write", "drive", ["3"]),
      ],
    });

    check("a plan that reads across services then writes out is refused", plan.ok === false, JSON.stringify(plan.ok));
    check("as cross_service_exfiltration", plan.ok === false && plan.verdict.code === "cross_service_exfiltration",
      plan.ok === false ? plan.verdict.code : "allowed");
    check("and it names the capabilities involved",
      plan.ok === false && /mail.read/.test(plan.verdict.reason) && /drive.write/.test(plan.verdict.reason),
      plan.ok === false ? plan.verdict.reason : "");
    check("saying each step is individually permitted",
      plan.ok === false && /each individual step is permitted/.test(plan.verdict.reason));

    /* The same shape under a low-risk goal is a notice, not a refusal. A
       signal that refuses everything is not a signal. */
    const lowRisk = buildPlan({
      goal: "tidy up my week",
      goalRisk: "low",
      capabilities: granted.surface,
      steps: [
        node("1", "gmail.read", "mail"),
        node("2", "calendar.read", "calendar", ["1"]),
        node("3", "drive.write", "drive", ["2"]),
      ],
    });
    check("under a low-risk goal the same shape is only noticed", lowRisk.ok === true, JSON.stringify(lowRisk));
    check("and the notice is recorded", lowRisk.ok === true && lowRisk.verdict.notices.length > 0);

    /* Reading and writing the SAME capability is ordinary work and must not
       be caught by the rule above. calendar.write was not in that surface,
       so this asks for a surface that has it — otherwise the assertion
       would be testing the not-granted check rather than the shape. */
    const calendarSurface = resolveSurface({
      registry,
      taskId: "calendar-only",
      needs: [{ capability: "calendar.read" }, { capability: "calendar.write" }],
    });
    if (calendarSurface.ok) {
      /* goalRisk matches the capability's real risk rather than being set
         high to sound strict. calendar.write is medium, so a high-risk goal
         here would be caught by privilege laundering — correctly, and for a
         reason that has nothing to do with the shape under test. */
      const sameCapability = buildPlan({
        goal: "file my notes",
        goalRisk: "medium",
        capabilities: calendarSurface.surface,
        steps: [node("1", "calendar.read", "calendar"), node("2", "calendar.write", "calendar", ["1"])],
      });
      check("reading and writing one capability is allowed", sameCapability.ok === true, JSON.stringify(sameCapability));
    }
  }

  /* A step naming a capability the task does not hold. The executor already
     refuses it, so this is the second lock on the same door — and the
     policy check names it in terms a reviewer can act on. */
  const narrow = resolveSurface({
    registry,
    taskId: "narrow",
    needs: [{ capability: "mail.read" }],
  });
  if (narrow.ok) {
    const ungranted = buildPlan({
      goal: "read mail and upload a video",
      goalRisk: "low",
      capabilities: narrow.surface,
      steps: [node("1", "gmail.read", "mail"), node("2", "youtube.upload", "youtube", ["1"])],
    });
    check("a step outside the surface is refused by the policy engine too", ungranted.ok === false);
    check("as capability_not_granted",
      ungranted.ok === false && ungranted.verdict.code === "capability_not_granted",
      ungranted.ok === false ? ungranted.verdict.code : "allowed");
    check("and names what WAS granted",
      ungranted.ok === false && /gmail.read/.test(ungranted.verdict.reason),
      ungranted.ok === false ? ungranted.verdict.reason : "");
  }
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
