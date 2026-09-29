import { AgentSession, defaultLedgerPath } from "../../lib/session";
import { defaultRegistry } from "../../lib/default-profiles";
import type { PlanNode } from "../../lib/policy-engine";
import type { CapabilityRequest } from "../../lib/capabilities";

/* =============================================================================
   Agent — the entry point to the execution path
   -----------------------------------------------------------------------------
   The one route that can cause a tool to run. Everything upstream of it
   already exists and is tested; this is where the chain becomes reachable
   from outside the process.

   What a client may send is deliberately narrow: a goal, the risk it claims
   for that goal, and a proposed decomposition. Not a tool. Not a payload for
   a named tool. Not an argv. A client that can name a skill is a client that
   can name the reserved `__` namespace, and the whole point of that
   namespace being closed at the gate is that nothing addresses it.

   A proposal is not a request to act. It is a request to be *judged* — the
   policy engine reads all of it before the first step runs, and the
   authority checks every step regardless of what the plan said it was for.

   The `replan` hook is absent from this route on purpose. Adaptation needs
   a strategy that can re-propose, and letting an HTTP body supply one would
   make the loop steerable from outside. The server holds that seam until
   there is a server-side strategy worth holding.
   ========================================================================== */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Refuse anything larger outright rather than parsing it. */
const MAX_BODY_BYTES = 256 * 1024;

type Body = {
  goal?: unknown;
  goalRisk?: unknown;
  steps?: unknown;
  needs?: unknown;
};

/** What the client says it needs. Names only — a client cannot widen its
 *  own scope by describing it more precisely. */
function readNeeds(value: unknown): { ok: true; needs: CapabilityRequest[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, needs: [] };
  if (!Array.isArray(value)) return { ok: false, error: "needs must be an array" };
  const needs: CapabilityRequest[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i] as { capability?: unknown; justification?: unknown } | null;
    if (!raw || typeof raw !== "object" || typeof raw.capability !== "string") {
      return { ok: false, error: `need ${i} has no capability name` };
    }
    needs.push({
      capability: raw.capability,
      justification: typeof raw.justification === "string" ? raw.justification : undefined,
    });
  }
  return { ok: true, needs };
}

const RISK = ["low", "medium", "high"] as const;

/**
 * Validate the proposed steps into the planner's shape.
 *
 * Structural only. Whether a step is *permitted* is the authority's and the
 * policy engine's question, not this function's — but a step that is not
 * even well-formed has to be refused before it can be judged, and the
 * refusal has to say which field was wrong rather than failing somewhere
 * deeper with a type error.
 */
function readSteps(value: unknown): { ok: true; steps: PlanNode[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "steps must be an array" };
  if (value.length === 0) return { ok: false, error: "steps must not be empty" };

  const steps: PlanNode[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `step ${i} is not an object` };
    }
    const { id, action, skill, payload, expected, dependsOn } = raw;
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, error: `step ${i} has no id` };
    }
    if (typeof action !== "string" || action.length === 0) {
      return { ok: false, error: `step "${id}" has no action` };
    }
    if (typeof expected !== "string" || expected.length === 0) {
      return { ok: false, error: `step "${id}" has no expectation to verify against` };
    }
    if (!skill || typeof skill !== "object") {
      return { ok: false, error: `step "${id}" has no skill` };
    }
    if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
      return { ok: false, error: `step "${id}" has a non-array dependsOn` };
    }
    steps.push({
      id,
      action,
      skill: skill as PlanNode["skill"],
      payload,
      expected,
      dependsOn: (dependsOn as string[] | undefined) ?? [],
    });
  }
  return { ok: true, steps };
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }

  let body: Body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return Response.json({ error: "request body is too large" }, { status: 413 });
    }
    body = JSON.parse(text) as Body;
  } catch {
    return Response.json({ error: "body is not valid JSON" }, { status: 400 });
  }

  if (typeof body.goal !== "string" || body.goal.trim().length === 0) {
    return Response.json({ error: "a goal is required" }, { status: 400 });
  }
  if (!RISK.includes(body.goalRisk as (typeof RISK)[number])) {
    return Response.json(
      {
        error:
          "goalRisk must be declared as one of low|medium|high; an undeclared goal risk cannot be weighed against the steps meant to achieve it",
      },
      { status: 400 },
    );
  }

  const parsed = readSteps(body.steps);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const needs = readNeeds(body.needs);
  if (!needs.ok) {
    return Response.json({ error: needs.error }, { status: 400 });
  }

  /* Every step must name a capability this request asked for. Checked here
     as well as in the engine so the client gets a refusal naming the
     capability it forgot, rather than a policy verdict about a plan it
     cannot see. Same check, two places: the route is where a caller learns
     what it may ask for, and the engine is where it holds regardless of
     who called it. */
  if (needs.ok && needs.needs.length > 0) {
    const asked = new Set(needs.needs.map((n) => n.capability));
    for (const step of parsed.steps) {
      const grant = defaultRegistry().allGrants().find((g) => g.action === step.action);
      if (!grant) continue; // unknown tools are the executor's business
      if (asked.has(grant.capability)) continue;
      return Response.json(
        {
          error: `step "${step.id}" needs capability "${grant.capability}", which this request did not ask for`,
          requested: [...asked],
        },
        { status: 403 },
      );
    }
  }

  try {
    const session = await AgentSession.open({
      ledgerPath: defaultLedgerPath(process.cwd().replace(/\/apps\/command-center$/, "")),
    }).then((s) => s.useRegistry(defaultRegistry()));

    const { outcome, summary } = await session.run({
      goal: body.goal,
      goalRisk: body.goalRisk as (typeof RISK)[number],
      steps: parsed.steps,
      needs: needs.ok ? needs.needs : [],
      /* No approve and no replan from the wire. Approval is a human
         decision and adaptation is a server strategy; neither is something
         an HTTP body should be able to supply. A medium or high-risk skill
         will therefore be refused here, and be refused visibly. */
    });

    /* The response carries the outcome and the chain's head, not the whole
       chain. The evidence is on disk and is addressed by id; shipping the
       entire history on every call would make the response size grow
       without bound and would put the ledger's contents in a log somewhere
       they do not need to be. */
    return Response.json(
      {
        status: outcome.status,
        reason: outcome.reason,
        completed: outcome.completed,
        replans: outcome.replans,
        steps: outcome.steps.map((s) => ({
          status: s.status,
          stepId: s.stepId,
          action: s.action,
          authorityReason: s.authorityReason,
          sealError: s.sealError,
        })),
        /* The capability set is returned so a caller can see what it was
           given, not only what it asked for. A surface nobody can read is a
           surface nobody can tell whether it was narrowed. */
        capabilities: session.surface()?.toJSON() ?? null,
        ledger: {
          path: summary.ledgerPath,
          entries: summary.entries,
          head: summary.head,
          chainOk: summary.chainOk,
          resumed: summary.resumed,
        },
      },
      { status: outcome.status === "completed" ? 200 : 409 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "the run could not be started" },
      { status: 500 },
    );
  }
}
