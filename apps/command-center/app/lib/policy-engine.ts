import { dirname, resolve } from "node:path";
import { isInside, type SkillMeta, type RiskLevel } from "./execution-authority";
import type { ToolSurface } from "./capabilities";

/* =============================================================================
   Policy Engine
   -----------------------------------------------------------------------------
   The authority judges one step at a time. That is the correct unit for a
   gate — it is the unit in which a decision can be explained to whoever was
   refused — but it is the wrong unit for a risk that only exists across
   steps.

   Twenty legal reads, each of a file the skill was always allowed to read,
   are reconnaissance. A skill set that writes the same file from six
   different places is assembling something no single call looks like. A plan
   whose stated goal is high risk while every step declares itself low is
   the shape the authority structurally cannot see, because it never looks at
   two calls at once.

   So this module answers a different question from the authority. Not "may
   this step run?" — that is settled before the plan is ever seen — but "is
   this plan, as a whole, something a person would have agreed to if they had
   read it end to end?"

   Two honest limits, stated up front:

   1. Every signal here is structural. This reads tool names, paths, skill
      metadata and dependency edges. It does not read intent, and it cannot.
      A plan that is structurally innocuous and malicious passes. The claim
      is narrow and worth having: composite risk is detectable, semantic
      intent is not.

   2. A signal is a reason to ask a human, not a verdict of malice. That is
      why most codes below are `review_required` rather than `denied`: the
      engine is the thing that makes a person look, not the thing that
      replaces them.
   ========================================================================== */

export type PlanNode = {
  id: string;
  action: string;
  skill: SkillMeta;
  payload: unknown;
  expected: string;
  /** Ids of steps that must have succeeded first. Empty for a root. */
  dependsOn: string[];
};

export type Plan = {
  goal: string;
  /** Declared by the host, never inferred from the goal string. */
  goalRisk?: RiskLevel;
  /** Topologically ordered. The order is the plan; see orderPlan. */
  steps: PlanNode[];
  /** 0 for a first plan, incremented for each replan. */
  attempt: number;
  /** The ledger entry a replan learned from. Never written, only read. */
  basedOn?: { entryId: string; status: string; reason?: string };
  /**
   * The session's capability set, when the plan is running inside one.
   *
   * Optional so that pure policy evaluation stays usable with no runtime
   * attached, and checked with a presence test rather than an assumption:
   * a plan evaluated without a surface has had its composition signals
   * skipped, and pretending otherwise would report a completeness that was
   * not earned.
   */
  capabilities?: ToolSurface;
};

export type PlanLimits = {
  maxSteps: number;
  maxDepth: number;
  maxReplans: number;
  /** Distinct directories a plan may read from. */
  maxReadDirectories: number;
  /** Distinct skills allowed to write the same target. */
  maxWritersPerTarget: number;
};

export const DEFAULT_LIMITS: PlanLimits = {
  maxSteps: 24,
  maxDepth: 8,
  maxReplans: 3,
  maxReadDirectories: 6,
  maxWritersPerTarget: 1,
};

export type PolicyCode =
  | "plan_too_large"
  | "plan_too_deep"
  | "dependency_missing"
  | "dependency_cycle"
  | "self_dependency"
  | "duplicate_step_id"
  | "empty_plan"
  | "goal_risk_unknown"
  | "privilege_laundering"
  | "enumeration_breadth"
  | "path_convergence"
  | "collect_then_write"
  | "reserved_action"
  | "undeclared_risk"
  | "capability_not_granted"
  | "capability_escalation"
  | "cross_service_exfiltration"
  | "requires_review";

export type PolicyVerdict =
  | { allowed: true; notices: string[] }
  | { allowed: false; code: PolicyCode; reason: string; notices: string[] };

/* Which actions touch the disk, and in which direction. An action not in
   either table is treated as a writer: an unrecognised tool is assumed to
   be able to change things, because the cost of guessing wrong in that
   direction is small and the cost in the other direction is the whole
   point of this module. */
const READ_ACTIONS = new Set(["read_file", "list_directory"]);
const WRITE_ACTIONS = new Set(["write_file", "delete_file", "move_file", "mkdir"]);

/* Whether an action reads or writes is a property of the *grant*, not of the
   action's name. `gmail.read` and `drive.write` say so in their names, but
   a service's read tool is still a read and hard-coding a list of every
   service's tool names means the first one added that nobody remembered
   becomes invisible to the composition rules — silently, which is the worst
   way for it to fail.
   
   So the direction is taken from the registry when a surface is present, and
   from the name only as a fallback for plans evaluated without one. A tool
   whose name says neither is treated as a writer, because a capability that
   might change things being classified as harmless is the expensive error. */
function isRead(step: PlanNode, surface?: ToolSurface): boolean {
  const grant = surface?.grantFor(step.action);
  if (grant) {
    return /(^|[.\-_])read$/.test(grant.capability) || /(^|[.\-_])(read|list|get|fetch|search)$/.test(step.action);
  }
  return READ_ACTIONS.has(step.action);
}

function isWrite(step: PlanNode, surface?: ToolSurface): boolean {
  const grant = surface?.grantFor(step.action);
  if (grant) {
    return (
      /(^|[.\-_])(write|send|upload|delete|remove|publish|create|update|put|post)$/.test(grant.capability) ||
      /(^|[.\-_])(write|send|upload|delete|remove|publish|create|update)$/.test(step.action)
    );
  }
  return WRITE_ACTIONS.has(step.action);
}

function payloadPath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const path = (payload as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}

/** The highest risk any step declares, or undefined if one declares none. */
export function planRisk(plan: Plan): RiskLevel | undefined {
  const order: RiskLevel[] = ["low", "medium", "high"];
  let highest: RiskLevel | undefined;
  for (const step of plan.steps) {
    const risk = step.skill?.risk_level as RiskLevel | undefined;
    if (!risk || !order.includes(risk)) return undefined;
    if (!highest || order.indexOf(risk) > order.indexOf(highest)) highest = risk;
  }
  return highest;
}

/**
 * Evaluate a whole plan before any of it runs.
 *
 * Structure first, because a malformed plan makes every later signal
 * meaningless — there is no point counting the directories in a graph with a
 * cycle in it.
 */
export function evaluatePlan(plan: Plan, limits: PlanLimits = DEFAULT_LIMITS): PolicyVerdict {
  const notices: string[] = [];

  /* ── shape ───────────────────────────────────────────────────────────── */
  if (plan.steps.length === 0) {
    return { allowed: false, code: "empty_plan", reason: "a plan with no steps has no goal left to pursue", notices };
  }
  if (plan.steps.length > limits.maxSteps) {
    return {
      allowed: false,
      code: "plan_too_large",
      reason: `plan has ${plan.steps.length} steps, above the bound of ${limits.maxSteps}`,
      notices,
    };
  }

  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id)) {
      return { allowed: false, code: "duplicate_step_id", reason: `two steps are both called "${step.id}"`, notices };
    }
    seen.add(step.id);

    /* Defence in depth, not the primary defence. The authority refuses the
       reserved namespace, so a plan containing one would fail at its first
       step anyway. Catching it here means a planner that emits internal
       actions is diagnosed as a planner bug rather than as a policy
       decision. */
    if (step.action.startsWith("__")) {
      return {
        allowed: false,
        code: "reserved_action",
        reason: `step "${step.id}" proposes the internal action "${step.action}", which no skill may invoke`,
        notices,
      };
    }

    const risk = step.skill?.risk_level as RiskLevel | undefined;
    if (!risk || !["low", "medium", "high"].includes(risk)) {
      return {
        allowed: false,
        code: "undeclared_risk",
        reason: `step "${step.id}" declares risk_level=${JSON.stringify(risk)}, which is not a declared level`,
        notices,
      };
    }
  }

  /* ── graph ───────────────────────────────────────────────────────────── */
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) {
        return { allowed: false, code: "self_dependency", reason: `step "${step.id}" depends on itself`, notices };
      }
      if (!seen.has(dep)) {
        return {
          allowed: false,
          code: "dependency_missing",
          reason: `step "${step.id}" depends on "${dep}", which is not in this plan`,
          notices,
        };
      }
    }
  }

  const cycle = findCycle(plan);
  if (cycle) {
    return {
      allowed: false,
      code: "dependency_cycle",
      reason: `the plan contains a dependency cycle: ${cycle.join(" → ")}`,
      notices,
    };
  }

  if (depthOf(plan) > limits.maxDepth) {
    return {
      allowed: false,
      code: "plan_too_deep",
      reason: `the dependency chain is ${depthOf(plan)} deep, above the bound of ${limits.maxDepth}`,
      notices,
    };
  }

  /* ── goal risk, declared and not guessed ─────────────────────────────── */
  if (!plan.goalRisk || !["low", "medium", "high"].includes(plan.goalRisk)) {
    return {
      allowed: false,
      code: "goal_risk_unknown",
      reason: `the goal declares risk_level=${JSON.stringify(plan.goalRisk)}, so nothing here can be weighed against it`,
      notices,
    };
  }

  /* ── composite signals ───────────────────────────────────────────────── */

  /* Privilege laundering. The plan's stated purpose is more dangerous than
     anything it proposes to do, which is the signature of a plan assembled
     to stay under a threshold: no step is worth refusing, so the authority
     refuses none of them, and the purpose is accomplished anyway. This is
     the one signal that cannot be expressed as a per-step rule at all. */
  /* The risk that counts is the risk of the capability being used, not the
     risk a step declares about itself. A step whose skill says `low` while
     the session's grant for that tool says `high` is the laundering case
     exactly, and reading the step's own label first would let the more
     specific signal be pre-empted by the more general one. So when a
     surface is present it is the authority on risk, and a step that
     under-declares is caught by the composition rules below instead. */
  const surfaceRisk = plan.capabilities?.capabilitiesRisk?.();
  const highest = surfaceRisk ?? planRisk(plan)!;
  const rank: RiskLevel[] = ["low", "medium", "high"];
  if (rank.indexOf(highest) < rank.indexOf(plan.goalRisk)) {
    return {
      allowed: false,
      code: "privilege_laundering",
      reason: `the goal is ${plan.goalRisk} risk but nothing in the plan exceeds ${highest}; the plan would assemble a ${plan.goalRisk}-risk outcome from steps that each declare themselves ${highest}`,
      notices,
    };
  }

  /* Enumeration breadth. Each read is inside a directory the skill was
     always allowed to read, so the authority permits every one. The
     aggregate is reconnaissance, and only an aggregate view sees it. */
  const readDirs = new Set<string>();
  for (const step of plan.steps) {
    if (!READ_ACTIONS.has(step.action)) continue;
    const path = payloadPath(step.payload);
    if (path) readDirs.add(dirname(resolve(path)));
  }
  if (readDirs.size > limits.maxReadDirectories) {
    return {
      allowed: false,
      code: "enumeration_breadth",
      reason: `the plan reads from ${readDirs.size} directories, above the bound of ${limits.maxReadDirectories}; each read is individually permitted, and the set of them is not`,
      notices,
    };
  }

  /* Path convergence. Many skills, one destination. No single write is
     remarkable; the agreement between them is. */
  const writersByTarget = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    if (!WRITE_ACTIONS.has(step.action)) continue;
    const path = payloadPath(step.payload);
    if (!path) continue;
    const target = resolve(path);
    if (!writersByTarget.has(target)) writersByTarget.set(target, new Set());
    writersByTarget.get(target)!.add(step.skill?.name ?? step.id);
  }
  for (const [target, writers] of writersByTarget) {
    if (writers.size > limits.maxWritersPerTarget) {
      return {
        allowed: false,
        code: "path_convergence",
        reason: `${writers.size} skills (${[...writers].join(", ")}) all write ${target}; a shared destination is not something any one of those calls is allowed to be on its own`,
        notices,
      };
    }
  }

  /* Collect, then write. Reads spread across directories and a write that
     depends on them is the shape of copying a workspace somewhere. Stated
     as what it is: a shape that deserves a human, not a proven exfiltration.
     Content is never inspected — only structure. */
  if (readDirs.size >= 2) {
    const writeSteps = plan.steps.filter((s) => WRITE_ACTIONS.has(s.action));
    if (writeSteps.length > 0) {
      notices.push(
        `the plan reads from ${readDirs.size} directories and then writes; this is a recognised collection shape and wants a human read`,
      );
      if (plan.goalRisk === "high") {
        return {
          allowed: false,
          code: "collect_then_write",
          reason: `a high-risk goal reads across ${readDirs.size} directories and then writes; the shape is the one a human should confirm before it runs`,
          notices,
        };
      }
    }
  }

  /* ── capability composition ──────────────────────────────────────────────
     The signals above look at one plan. These look at what the plan does to
     the *session's* capability set, which is the other half of the risk: not
     what a step says it is, but where the data ends up.

     The shape is the same one a data exfiltration takes and it is visible
     without reading a single byte of content: read from several services,
     gather them into a dependency chain, write the result somewhere the
     task was never granted. */
  if (plan.capabilities) {
    const surfaces = plan.capabilities;

    /* A step using a capability the session does not hold. Normally
       impossible — the surface is enforced at the executor before a process
       starts — so reaching this means a plan was assembled outside the
       session, which is a bug worth naming rather than quietly dropping. */
    for (const step of plan.steps) {
      if (surfaces.has(step.action)) continue;
      return {
        allowed: false,
        code: "capability_not_granted",
        reason: `step "${step.id}" uses "${step.action}", which is not in this task's capability set (granted: ${
          surfaces.actions().join(", ") || "nothing"
        })`,
        notices,
      };
    }

    /* Read across services, then write. Each read is inside a capability the
       task holds; the aggregation across them is what the task was not
       asked for. Reported by capability rather than by tool name, because
       the question a reviewer asks is "why did this need three services?"
       and a list of tool names does not answer it. */
    const readCapabilities = new Set<string>();
    for (const step of plan.steps) {
      if (!isRead(step, surfaces)) continue;
      const grant = surfaces.grantFor(step.action);
      if (grant) readCapabilities.add(grant.capability);
    }

    const writeSteps = plan.steps.filter((s) => isWrite(s, surfaces));
    if (readCapabilities.size >= 2 && writeSteps.length > 0) {
      const writeCapabilities = new Set<string>();
      for (const step of writeSteps) {
        const grant = surfaces.grantFor(step.action);
        if (grant) writeCapabilities.add(grant.capability);
      }
      /* A read/write split across capabilities is the exfiltration shape. A
         plan that reads and writes the *same* capability — edit a note, say —
         is ordinary work, and refusing it would be the signal becoming a
         denier of everything. */
      const crossed = [...writeCapabilities].some((c) => !readCapabilities.has(c));
      if (crossed) {
        const reason =
          `the plan reads across ${readCapabilities.size} capabilities (${[...readCapabilities].sort().join(", ")}) ` +
          `and writes to ${[...writeCapabilities].sort().join(", ")}; gathering from several services and writing ` +
          `elsewhere is a shape a person should confirm, and each individual step is permitted on its own`;
        if (plan.goalRisk === "high") {
          return { allowed: false, code: "cross_service_exfiltration", reason, notices };
        }
        notices.push(reason);
      }
    }
  }

  return { allowed: true, notices };
}

/** The cycle itself, named. A graph is not fixable and a "cycle detected" is not actionable. */
function findCycle(plan: Plan): string[] | null {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const step of plan.steps) {
    const found = walk(step.id);
    if (found) return found;
  }
  return null;
}

/** Length of the longest dependency chain, in edges. A flat plan is 0. */
export function depthOf(plan: Plan): number {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();

  const walk = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0; // cycle; evaluatePlan refuses it first
    seen.add(id);
    let deepest = 0;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      deepest = Math.max(deepest, walk(dep, seen) + 1);
    }
    seen.delete(id);
    memo.set(id, deepest);
    return deepest;
  };

  return plan.steps.reduce((max, s) => Math.max(max, walk(s.id, new Set())), 0);
}
