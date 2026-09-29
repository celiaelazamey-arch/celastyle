import { isInside, type RiskLevel } from "./execution-authority";

/* =============================================================================
   Capabilities
   -----------------------------------------------------------------------------
   The registry of what exists, and the resolver of what this task may touch.

   The distinction this module exists to draw is between a tool being refused
   and a tool not existing. A refusal is a branch: it is a decision some
   code made, it can be mis-wired, and it is one bug away from not being made.
   Absence is not a decision, it is a property of the surface the agent was
   given, and it holds even if every guard downstream of it is broken.

   So the agent is handed a `ToolSurface` — an explicit, closed set — and
   never the registry. The registry is what the *host* holds, the way a
   process holds its own credentials and does not hand them to the code it
   runs. A plan that names a tool outside its surface names something that
   was never on offer, exactly as a request for a method that does not exist
   names nothing at all.

   Three rules, and they are the whole design:

   1. Least privilege by narrowing, not by naming. A profile is a bundle the
      host picks from. The surface it produces is the intersection of what
      was asked for and what the profile grants — so asking for less is
      always possible and asking for more is not. The surface records the
      *requested* scope, never the granted one, because a surface that
      records the wider scope has quietly handed back the privilege it was
      supposed to reduce.

   2. The default is never everything. `resolveSurface` requires an explicit
      list of needs; there is no call that returns the registry. An agent
      that asked for "all tools" gets what it asked for or nothing, and the
      registry's full grant set is never reachable from a session by
      accident — only by a caller that names every capability deliberately.

   3. Granting later is additive and audited. A capability that turns out to
      be needed mid-task is requested, checked, and *added* — the existing
      surface is immutable and is never widened in place, so nothing that
      already ran can retroactively become permitted.
   ========================================================================== */

/** A concrete callable. This is what a step names. */
export type ToolId = string;

/** What a tool is allowed to touch. The unit of least privilege. */
export type CapabilityId = string;

export type Grant = {
  action: ToolId;
  capability: CapabilityId;
  /** Directories, accounts, or resources this tool may act on. Empty means
   *  the tool declares no scope of its own, which the authority treats as a
   *  refusal for anything filesystem-shaped. */
  scopes: string[];
  risk: RiskLevel;
  /** High-impact capabilities cannot be self-granted. */
  requiresApproval: boolean;
  /**
   * Does this capability need a credential at all?
   *
   * Omitted means yes. That default is the fail-closed one: a capability
   * that quietly needed a token but was marked as not needing one would be
   * an invisible hole, whereas a capability wrongly marked as needing one is
   * merely unavailable until someone binds it.
   *
   * The distinction exists so that "local, no secret involved" and "we
   * forgot to write a scope binding" cannot look the same to a reviewer, or
   * to the downscoper.
   */
  requiresToken?: boolean;
  estimatedCost?: number;
};

/** A named bundle. A convenience for the host, never handed to the agent. */
export type ToolProfile = {
  id: string;
  description?: string;
  grants: Grant[];
};

/** What a task says it needs, and why. */
export type CapabilityRequest = {
  capability: CapabilityId;
  /** Optional and narrowing: ask for a sub-scope of what the profile
   *  grants. A request whose scopes fall outside the grant resolves to
   *  nothing rather than to the grant. */
  scopes?: string[];
  justification?: string;
};

export class ToolRegistry {
  private readonly profiles = new Map<string, ToolProfile>();

  register(profile: ToolProfile): this {
    this.profiles.set(profile.id, profile);
    return this;
  }

  get(id: string): ToolProfile | undefined {
    return this.profiles.get(id);
  }

  list(): ToolProfile[] {
    return [...this.profiles.values()];
  }

  /** Every grant known to the system. Host-side only — nothing in the
   *  execution path calls this to build a surface. */
  allGrants(): Grant[] {
    return this.list().flatMap((p) => p.grants);
  }
}

/**
 * The closed set of tools one task may use.
 *
 * Immutable and explicit. There is no method that adds to it; widening goes
 * through `extendSurface`, which returns a new one. A surface that could be
 * mutated in place could be mutated by the code it is supposed to constrain,
 * and a capability boundary that the constrained code can edit is not a
 * boundary.
 */
export type ToolSurface = {
  readonly taskId: string;
  /** Total estimated cost of the surface, for a budget check. */
  totalCost(): number;
  capabilities(): CapabilityId[];
  actions(): ToolId[];
  has(action: ToolId): boolean;
  grantFor(action: ToolId): Grant | undefined;
  /**
   * The highest risk of anything in the surface, per the registry's grants.
   *
   * This is deliberately not derivable from a plan. A step's own declared
   * risk is a claim by the proposer, and a proposer that under-declares its
   * own risk is exactly the case the policy engine needs to catch. The
   * surface's number comes from the host's registration and is not the
   * agent's to lower.
   */
  capabilitiesRisk?(): RiskLevel | undefined;
  /** Why an action is unavailable, for a refusal a person can act on. */
  denyReasonFor(action: ToolId): string | null;
  /** Every action, for handing to something that needs to enumerate. */
  toJSON(): { taskId: string; capabilities: CapabilityId[]; actions: ToolId[] };
};

export type RefusedNeed = {
  capability: CapabilityId;
  reason: string;
};

export type Resolution =
  | { ok: true; surface: ToolSurface; refused: RefusedNeed[] }
  | { ok: false; reason: string; refused: RefusedNeeds };

type RefusedNeeds = RefusedNeed[];

/**
 * Build the surface for one task.
 *
 * `needs` is required and there is no wildcard. A caller that wants
 * everything has to name every capability, one by one, which is the point:
 * the day a new capability is registered, nothing inherits it.
 */
export function resolveSurface(input: {
  registry: ToolRegistry;
  taskId: string;
  needs: CapabilityRequest[];
  /** Optional ceiling on summed estimated cost. */
  budget?: number;
}): Resolution {
  const { registry, taskId, needs, budget } = input;
  const refused: RefusedNeed[] = [];

  if (needs.length === 0) {
    /* An empty need list is a legitimate answer — the task turns out to
       need nothing — but it must be an answer somebody made. Returning the
       registry here is the single most damaging line this module could
       contain, so the empty case yields an empty surface. */
    return { ok: true, surface: makeSurface(taskId, []), refused };
  }

  const chosen = new Map<ToolId, Grant>();

  for (const need of needs) {
    const candidates = registry.allGrants().filter((g) => g.capability === need.capability);

    if (candidates.length === 0) {
      refused.push({
        capability: need.capability,
        reason: `no registered tool provides "${need.capability}"${
          need.justification ? ` (asked for: ${need.justification})` : ""
        }`,
      });
      continue;
    }

    /* No scopes requested: take the grant as it is. Scopes requested: keep
       only the requested ones, and only where a grant covers them. The
       stored grant carries the *narrowed* scope, so the surface cannot be
       used to reach anything the task did not ask for. */
    if (!need.scopes || need.scopes.length === 0) {
      for (const grant of candidates) chosen.set(grant.action, grant);
      continue;
    }

    for (const scope of need.scopes) {
      const covering = candidates.filter(
        (g) => g.scopes.length === 0 || g.scopes.some((s) => isInside(s, scope)),
      );
      if (covering.length === 0) {
        refused.push({
          capability: need.capability,
          reason: `"${need.capability}" is not available for ${scope}; the registered tools grant ${
            candidates.map((g) => g.scopes.join(",") || "(no scope)").join(" / ")
          }`,
        });
        continue;
      }
      for (const grant of covering) {
        chosen.set(grant.action, { ...grant, scopes: [scope] });
      }
    }
  }

  const surface = makeSurface(taskId, [...chosen.values()]);

  /* A budget is an advisory guard, and the honest reason is worth stating:
     the number comes from the same proposal the tool calls come from, so an
     agent under-reports and gets under-reported totals. This catches gross
     overspend and honest accounting; it does not stop a determined
     understatement, and it is not a spend limit. */
  if (budget !== undefined && surface.totalCost() > budget) {
    return {
      ok: false,
      refused,
      reason: `the requested capabilities cost ${surface.totalCost()}, above the budget of ${budget}`,
    };
  }

  /* Every need refused is not a partial success, it is a task that cannot
     run. Returning an empty surface as a success would let a run start with
     nothing and discover it at the first step. */
  if (surface.actions().length === 0) {
    return {
      ok: false,
      refused,
      reason: `none of the requested capabilities are available: ${refused.map((r) => r.reason).join("; ")}`,
    };
  }

  return { ok: true, surface, refused };
}

/** Why a resolution failed, as a sentence. Key-checked rather than narrowed by
 *  a ternary on `ok`, which narrows only under some compiler settings — the
 *  same rule planner.ts and session.ts follow. Exported so the session can
 *  say the same thing the same way instead of growing its own copy. */
export function explainResolution(resolution: Resolution): string {
  return "reason" in resolution ? resolution.reason : "resolved";
}

function makeSurface(taskId: string, grants: Grant[]): ToolSurface {
  const byAction = new Map(grants.map((g) => [g.action, g]));
  return {
    taskId,
    totalCost: () => grants.reduce((sum, g) => sum + (g.estimatedCost ?? 0), 0),
    capabilities: () => [...new Set(grants.map((g) => g.capability))].sort(),
    actions: () => [...byAction.keys()].sort(),
    has: (action) => byAction.has(action),
    grantFor: (action) => byAction.get(action),
    capabilitiesRisk: () => {
      const order: RiskLevel[] = ["low", "medium", "high"];
      let highest: RiskLevel | undefined;
      for (const grant of grants) {
        if (!highest || order.indexOf(grant.risk) > order.indexOf(highest)) highest = grant.risk;
      }
      return highest;
    },
    denyReasonFor: (action) => {
      if (byAction.has(action)) return null;
      const sameCapability = grants.find((g) => g.action === action);
      /* Two different refusals, deliberately worded differently. "No such
         tool" means the registry has never heard of it. "Not available for
         this task" means it exists, is registered, and is pointed
         somewhere else — which is a request the host can act on by widening
         the task rather than by debugging a typo. */
      return sameCapability
        ? `"${action}" exists but is not in this task's capability set (${byAction.size} tool(s) granted)`
        : `"${action}" is not in this task's capability set; it was never made available (granted: ${
            byAction.size === 0 ? "nothing" : [...byAction.keys()].join(", ")
          })`;
    },
    toJSON: () => ({
      taskId,
      capabilities: [...new Set(grants.map((g) => g.capability))].sort(),
      actions: [...byAction.keys()].sort(),
    }),
  };
}

/* ── just-in-time extension ─────────────────────────────────────────────── */

export type Extension =
  | { ok: true; surface: ToolSurface; granted: ToolId[] }
  | { ok: false; reason: string; code: "unknown" | "needs_approval" | "approval_denied" };

/**
 * Add a capability to a task that turns out to need one.
 *
 * Returns a *new* surface. The old one is untouched, and everything already
 * run under it stays under exactly the set it was given — a boundary that
 * widens retroactively is not a boundary.
 *
 * Approval is required for anything marked high-impact, and "required" means
 * the function is called and its answer obeyed. An absent approver is not a
 * yes.
 */
export async function extendSurface(input: {
  surface: ToolSurface;
  registry: ToolRegistry;
  need: CapabilityRequest;
  approve?: (request: {
    capability: CapabilityId;
    action: ToolId;
    justification?: string;
  }) => Promise<boolean | undefined> | boolean | undefined;
}): Promise<Extension> {
  const { surface, registry, need } = input;

  const resolved = resolveSurface({
    registry,
    taskId: surface.taskId,
    needs: [need],
  });
  if (!resolved.ok) {
    return { ok: false, code: "unknown", reason: explainResolution(resolved) };
  }

  const additions = resolved.surface.actions().filter((a) => !surface.has(a));
  if (additions.length === 0) {
    return { ok: true, surface, granted: [] };
  }

  for (const action of additions) {
    const grant = resolved.surface.grantFor(action)!;
    if (!grant.requiresApproval) continue;

    if (!input.approve) {
      return {
        ok: false,
        code: "needs_approval",
        reason: `"${grant.capability}" is high-impact and requires approval, and no approver is available`,
      };
    }
    const verdict = await input.approve({
      capability: grant.capability,
      action,
      justification: need.justification,
    });
    /* Only exactly `true` approves. undefined from an unimplemented stub,
       null, a falsy value — all refusals, matching the authority's posture
       so there is one rule about consent rather than two. */
    if (verdict !== true) {
      return {
        ok: false,
        code: "approval_denied",
        reason: `approval for "${grant.capability}" was not granted`,
      };
    }
  }

  /* The merged surface keeps every existing grant exactly as it was, so the
     only difference between the old and new surface is what was added. */
  const merged: Grant[] = [];
  for (const action of surface.actions()) {
    const grant = surface.grantFor(action);
    if (grant) merged.push(grant);
  }
  for (const action of additions) {
    const grant = resolved.surface.grantFor(action)!;
    merged.push(grant);
  }

  return { ok: true, surface: makeSurface(surface.taskId, merged), granted: additions };
}
