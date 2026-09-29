import { isAbsolute, relative, resolve, sep } from "node:path";

/* =============================================================================
   Execution Authority
   -----------------------------------------------------------------------------
   The single place where a proposed tool call is allowed or refused.

   The design this replaces had two holes, both of which turn a security gate
   into decoration:

   1. It checked the tool's NAME and never its ARGUMENTS. A skill holding
      `allowed_tools: ["write_file"]` satisfied the gate by writing to
      /etc/passwd. Knowing which tool you are is not permission to aim it
      anywhere.
   2. It only asked for approval at risk `high`, so a `medium` skill passed
      through unchallenged — and the schema defaults
      `requires_human_approval` to false, which makes an author's silence
      mean "go".

   Both are fail-open shapes. This module fails closed on every uncertainty:
   an absent field, an unrecognised value, an approval function that returns
   nothing, or a payload in a shape it does not recognise are all refusals.
   A gate that has to be talked into saying yes is a gate that will eventually
   be talked into saying yes by something that should not have asked.

   Nothing here executes anything. The authority decides; the executor acts;
   the verifier later checks. Those three stay separate on purpose — a
   component that both decides and acts cannot be audited.
   ========================================================================== */

export type RiskLevel = "low" | "medium" | "high";

export type SkillMeta = {
  name: string;
  /** Optional on the type on purpose: metadata arrives from outside, and
   *  "the field was not there" is a real state a runtime has to survive.
   *  Required-at-the-type would push that failure to a crash instead of a
   *  refusal. */
  risk_level?: string;
  requires_human_approval?: boolean;
  allowed_tools?: string[];
  /** Argument-level scope. A tool with no directory constraint can still
   *  declare one; a tool that touches the filesystem must. */
  allowed_directories?: string[];
  timeout_ms?: number;
};

export type ToolRequest = {
  tool: string;
  /** Untrusted. Shape is checked before it is read, never after. */
  payload?: unknown;
};

/* Why a call was refused. Specific, because "denied" with no reason is
   indistinguishable from a crash, and a reviewer cannot act on either. */
export type DenialCode =
  | "unknown_skill"
  | "missing_metadata"
  | "unknown_risk_level"
  | "tool_not_allowed"
  | "unknown_tool"
  | "malformed_payload"
  | "path_not_allowed"
  | "approval_required"
  | "approval_denied"
  | "approval_unanswered";

export type Decision =
  | { allowed: true; skill: string; tool: string }
  | { allowed: false; code: DenialCode; reason: string };

/* Returns true to approve. Anything that is not exactly `true` — undefined
   from an unimplemented stub, null, a rejected promise's value — is a
   refusal. This is the whole fail-secure posture in one line. */
export type ApprovalFn = (request: {
  skill: string;
  tool: string;
  payload: unknown;
}) => Promise<boolean | undefined> | boolean | undefined;

/* ============================================================================
   Path containment
   ========================================================================= */

/**
 * Is `child` inside `parent`?
 *
 * Deliberately not `child.startsWith(parent)`. That is the classic sibling
 * bug: "/srv/data-evil" starts with "/srv/data", so a path-prefix check
 * admits a directory one character away from the one you meant to allow.
 * `relative` asks the filesystem-theoretical question instead, and handles
 * the "exactly equal" and "one level up" cases correctly.
 */
export function isInside(parent: string, child: string): boolean {
  if (parent === "") return false;
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  // A relative path that starts with ".." has escaped; an absolute one means
  // it landed on a different root entirely (drive letters, POSIX root).
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve a caller-supplied path and confine it to the skill's directories.
 *
 * Lexical resolution, which collapses ".." before it can point anywhere. It
 * cannot see symlinks: a link inside an allowed directory pointing outside it
 * passes this check and lands outside. Resolving that needs `realpath` on
 * the closest existing ancestor at execution time — which is the executor's
 * job, and is stated here rather than left as a surprise.
 */
function confinePath(
  rawPath: string,
  allowedDirectories: string[],
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "path must be a non-empty string" };
  }

  // Relative paths are resolved against the workspace, never against the
  // process CWD — a gate that trusts CWD is a gate that changes meaning
  // depending on who started the server.
  const resolved = resolve(allowedDirectories[0] ?? process.cwd(), rawPath);

  const permitted = allowedDirectories.some((dir) => isInside(dir, resolved));
  if (!permitted) {
    return {
      ok: false,
      reason: `path escapes every allowed directory: ${resolved}`,
    };
  }

  return { ok: true, path: resolved };
}

/* ============================================================================
   Argument validation
   ========================================================================= */

/* Per-tool argument rules. A tool with no entry is refused outright rather
   than passed through unchecked: an unrecognised tool is a tool nobody has
   reasoned about what it can be aimed at. */
type PayloadRule = {
  /** Directory constraint, applied to payload.path. */
  requiresPathWithin: true;
  /** Reject payloads that are not plain objects. A string or an array
   *  reaching a filesystem tool is a bug in the caller at best. */
  shape: "object";
};

const TOOL_RULES: Record<string, PayloadRule> = {
  write_file: { requiresPathWithin: true, shape: "object" },
  read_file: { requiresPathWithin: true, shape: "object" },
};

/* A payload with a prototype chain, a null prototype, or a class instance is
   not a plain object. `__proto__` on such a payload is the shape used to
   poison a merge downstream, and refusing it here is cheaper than auditing
   every consumer. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validatePayload(
  tool: string,
  payload: unknown,
  allowedDirectories: string[],
): { ok: true } | { ok: false; code: DenialCode; reason: string } {
  const rule = TOOL_RULES[tool];
  if (!rule) {
    return {
      ok: false,
      code: "unknown_tool",
      reason: `no argument policy is defined for tool "${tool}"`,
    };
  }

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      code: "malformed_payload",
      reason: `${tool} expects a plain object payload`,
    };
  }

  if (Object.prototype.hasOwnProperty.call(payload, "__proto__")) {
    return {
      ok: false,
      code: "malformed_payload",
      reason: "payload carries a __proto__ key",
    };
  }

  if (rule.requiresPathWithin) {
    if (allowedDirectories.length === 0) {
      return {
        ok: false,
        code: "path_not_allowed",
        reason: `${tool} touches the filesystem but the skill declares no allowed_directories`,
      };
    }
    const confined = confinePath(payload.path as string, allowedDirectories);
    if (confined.ok === false) {
      return { ok: false, code: "path_not_allowed", reason: confined.reason };
    }
  }

  return { ok: true };
}

/* ============================================================================
   The gate
   ========================================================================= */

const KNOWN_RISK: RiskLevel[] = ["low", "medium", "high"];

/**
 * Decide whether a tool call may proceed.
 *
 * `approve` is injected so the approval step is testable and so a
 * not-yet-implemented approver can be simulated honestly. Production passes
 * the real one; tests pass one that answers, or deliberately does not.
 */
export async function authorize(
  request: ToolRequest,
  skill: SkillMeta | null | undefined,
  approve?: ApprovalFn,
): Promise<Decision> {
  if (!skill || typeof skill !== "object") {
    return { allowed: false, code: "unknown_skill", reason: "no skill metadata supplied" };
  }

  if (typeof skill.name !== "string" || skill.name.length === 0) {
    return { allowed: false, code: "missing_metadata", reason: "skill has no name" };
  }

  // A missing or unrecognised risk level is not "low". Treating an absent
  // value as the permissive one is how a gate becomes a formality.
  if (typeof skill.risk_level !== "string" || !KNOWN_RISK.includes(skill.risk_level as RiskLevel)) {
    return {
      allowed: false,
      code: "unknown_risk_level",
      reason: `skill declares risk_level=${JSON.stringify(skill.risk_level)}, which is not one of low|medium|high`,
    };
  }
  const risk = skill.risk_level as RiskLevel;

  if (!Array.isArray(skill.allowed_tools)) {
    return {
      allowed: false,
      code: "missing_metadata",
      reason: "skill declares no allowed_tools",
    };
  }

  if (!request || typeof request.tool !== "string" || request.tool.length === 0) {
    return { allowed: false, code: "unknown_tool", reason: "request names no tool" };
  }

  if (!skill.allowed_tools.includes(request.tool)) {
    return {
      allowed: false,
      code: "tool_not_allowed",
      reason: `tool "${request.tool}" is not permitted for skill "${skill.name}"`,
    };
  }

  const payloadCheck = validatePayload(
    request.tool,
    request.payload,
    skill.allowed_directories ?? [],
  );
  if (payloadCheck.ok === false) {
    return { allowed: false, code: payloadCheck.code, reason: payloadCheck.reason };
  }

  /* Approval is required for medium and high unconditionally. The skill's own
     `requires_human_approval` flag can *raise* the bar for a low-risk skill
     but can never lower it — otherwise a medium skill could opt itself out
     by leaving the field at its schema default, which is exactly the hole
     this replaces. */
  const needsApproval =
    risk === "medium" || risk === "high" || skill.requires_human_approval === true;

  if (needsApproval) {
    if (!approve) {
      return {
        allowed: false,
        code: "approval_required",
        reason: `${risk} risk requires an approval decision, but no approver is wired up`,
      };
    }

    let answer: boolean | undefined;
    try {
      answer = await approve({ skill: skill.name, tool: request.tool, payload: request.payload });
    } catch {
      // An approver that throws has not approved anything. Swallowing the
      // error into a refusal keeps a transport hiccup from looking like a
      // bypass, and the reason says which path was taken.
      return {
        allowed: false,
        code: "approval_unanswered",
        reason: "the approval step failed; treating as not approved",
      };
    }

    if (answer !== true) {
      return {
        allowed: false,
        code: answer === false ? "approval_denied" : "approval_unanswered",
        reason:
          answer === false
            ? "an operator refused this action"
            : "the approval step returned no decision; refusing rather than assuming",
      };
    }
  }

  return { allowed: true, skill: skill.name, tool: request.tool };
}

export type { ToolRequest as ExecutionRequest };
export const _internal = { isInside, isPlainObject } as const;
