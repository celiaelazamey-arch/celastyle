/**
 * Execution Authority — the gate that decides who may act.
 *
 * A security gate is not judged by the calls it permits, which are usually
 * correct by accident, but by the calls it refuses. So most of this file
 * asserts refusals, and each one names the specific reason code rather than
 * just "denied" — a gate that refuses for the wrong reason is a gate that is
 * one bug away from refusing for the right one, or from allowing.
 *
 * The two holes this replaces are covered first and explicitly:
 *   - medium-risk skills used to pass unchallenged (fail-open),
 *   - a permitted tool used to be able to write anywhere (/etc/passwd).
 */
import { authorize, _internal } from "../.test-build-workspace/execution-authority.js";

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

const allow = async (req, skill, approve) => (await authorize(req, skill, approve)).allowed;
const refusesWith = async (req, skill, approve, code) => {
  const d = await authorize(req, skill, approve);
  return d.allowed === false && d.code === code;
};

const yes = () => true;
const no = () => false;
const silent = () => undefined;

const write = (path, content = "payload") => ({ path, content });

const WORKSPACE = "/srv/workspace";

// ── the two headline holes ─────────────────────────────────────────────────
console.log("\n\x1b[1mthe holes this gate was built to close\x1b[0m");

{
  // fail-open: a medium skill with the approval flag left at its schema
  // default used to run unchecked. Silence must not mean "go".
  const medium = {
    name: "fs-write-safe",
    risk_level: "medium",
    requires_human_approval: false, // the default, deliberately
    allowed_tools: ["write_file"],
    allowed_directories: [WORKSPACE],
  };
  check(
    "a medium-risk skill is refused when approval was never granted",
    !(await allow({ tool: "write_file", payload: write(`${WORKSPACE}/a.txt`) }, medium)),
  );
  check(
    "a medium skill can be approved explicitly",
    await allow({ tool: "write_file", payload: write(`${WORKSPACE}/a.txt`) }, medium, yes),
  );
}

{
  // identity vs content: being allowed to use write_file is not permission to
  // aim it at the system.
  const lowWrite = {
    name: "note-taker",
    risk_level: "low",
    allowed_tools: ["write_file"],
    allowed_directories: [WORKSPACE],
  };
  check(
    "a write outside every allowed directory is refused",
    await refusesWith(
      { tool: "write_file", payload: write("/etc/passwd", "owned") },
      lowWrite,
      undefined,
      "path_not_allowed",
    ),
  );
}

// ── path containment ───────────────────────────────────────────────────────
console.log("\n\x1b[1mpath containment\x1b[0m");

const confined = {
  name: "note-taker",
  risk_level: "low",
  allowed_tools: ["write_file", "read_file"],
  allowed_directories: [WORKSPACE],
};

{
  check(
    "a write inside the workspace is allowed",
    await allow({ tool: "write_file", payload: write(`${WORKSPACE}/notes.md`) }, confined),
  );
  check(
    "a write into a nested directory is allowed",
    await allow({ tool: "write_file", payload: write(`${WORKSPACE}/a/b/c.md`) }, confined),
  );
  check(
    "a traversal out of the workspace is refused",
    await refusesWith(
      { tool: "write_file", payload: write(`${WORKSPACE}/../../etc/shadow`) },
      confined,
      undefined,
      "path_not_allowed",
    ),
  );
  check(
    "a traversal that lands back inside is allowed",
    await allow({ tool: "write_file", payload: write(`${WORKSPACE}/x/../notes.md`) }, confined),
  );
}

{
  /* The sibling bug. "/srv/workspace-evil" begins with the string
     "/srv/workspace", so a startsWith() check admits a directory one
     character away from the one that was meant to be allowed. This is the
     single easiest way to write a convincing-looking path check that is
     wrong. */
  check(
    "a sibling directory sharing a name prefix is refused",
    await refusesWith(
      { tool: "write_file", payload: write("/srv/workspace-evil/keys.txt") },
      confined,
      undefined,
      "path_not_allowed",
    ),
  );
  check("isInside rejects the prefix sibling directly", !_internal.isInside("/srv/data", "/srv/data-evil"));
  check("isInside accepts a genuine child", _internal.isInside("/srv/data", "/srv/data/x"));
  check("isInside accepts the directory itself", _internal.isInside("/srv/data", "/srv/data"));
}

{
  check(
    "a filesystem skill with no allowed_directories is refused",
    await refusesWith(
      { tool: "write_file", payload: write("/tmp/anything") },
      { name: "s", risk_level: "low", allowed_tools: ["write_file"] },
      undefined,
      "path_not_allowed",
    ),
  );
}

// ── fail-secure metadata handling ──────────────────────────────────────────
console.log("\n\x1b[1ffailing secure on missing metadata\x1b[0m");

{
  check(
    "a skill with no risk level is refused, not assumed low",
    await refusesWith(
      { tool: "read_file", payload: write(`${WORKSPACE}/a`) },
      { name: "s", allowed_tools: ["read_file"], allowed_directories: [WORKSPACE] },
      undefined,
      "unknown_risk_level",
    ),
  );
  check(
    "an unrecognised risk level is refused",
    await refusesWith(
      { tool: "read_file", payload: write(`${WORKSPACE}/a`) },
      { name: "s", risk_level: "spicy", allowed_tools: ["read_file"], allowed_directories: [WORKSPACE] },
      undefined,
      "unknown_risk_level",
    ),
  );
  check(
    "a skill with no allowed_tools is refused",
    await refusesWith(
      { tool: "read_file", payload: write(`${WORKSPACE}/a`) },
      { name: "s", risk_level: "low", allowed_directories: [WORKSPACE] },
      undefined,
      "missing_metadata",
    ),
  );
  check("absent skill metadata is refused", await refusesWith({ tool: "read_file" }, null, undefined, "unknown_skill"));
  check("undefined skill metadata is refused", await refusesWith({ tool: "read_file" }, undefined, undefined, "unknown_skill"));
}

{
  check(
    "a tool outside allowed_tools is refused",
    await refusesWith(
      { tool: "network_request", payload: { url: "https://x" } },
      { name: "s", risk_level: "low", allowed_tools: ["read_file"], allowed_directories: [WORKSPACE] },
      undefined,
      "tool_not_allowed",
    ),
  );
  check(
    "an allowed tool with no argument policy is still refused",
    await refusesWith(
      { tool: "shell_exec", payload: { cmd: "ls" } },
      { name: "s", risk_level: "low", allowed_tools: ["shell_exec"] },
      undefined,
      "unknown_tool",
    ),
  );
}

// ── approval semantics ─────────────────────────────────────────────────────
console.log("\n\x1b[1mapproval fails closed\x1b[0m");

{
  const high = {
    name: "deploy",
    risk_level: "high",
    allowed_tools: ["write_file"],
    allowed_directories: [WORKSPACE],
  };
  check(
    "a high-risk action with no approver wired up is refused",
    await refusesWith({ tool: "write_file", payload: write(`${WORKSPACE}/x`) }, high, undefined, "approval_required"),
  );
  check(
    "an approver that returns nothing is a refusal",
    await refusesWith({ tool: "write_file", payload: write(`${WORKSPACE}/x`) }, high, silent, "approval_unanswered"),
  );
  check(
    "an approver that says no is a refusal",
    await refusesWith({ tool: "write_file", payload: write(`${WORKSPACE}/x`) }, high, no, "approval_denied"),
  );
  check(
    "an approver that throws is a refusal, not a bypass",
    await refusesWith(
      { tool: "write_file", payload: write(`${WORKSPACE}/x`) },
      high,
      () => {
        throw new Error("approval transport died");
      },
      "approval_unanswered",
    ),
  );
  check(
    "a high-risk action is allowed once an operator approves",
    await allow({ tool: "write_file", payload: write(`${WORKSPACE}/x`) }, high, yes),
  );
}

{
  /* The flag raises the bar; it must never lower it. If it could, a medium
     skill would be able to opt itself out by leaving a field at its default. */
  const low = {
    name: "s",
    risk_level: "low",
    requires_human_approval: true,
    allowed_tools: ["read_file"],
    allowed_directories: [WORKSPACE],
  };
  check(
    "a low-risk skill can still demand approval",
    !(await allow({ tool: "read_file", payload: write(`${WORKSPACE}/a`) }, low)),
  );
  check(
    "and proceeds once approved",
    await allow({ tool: "read_file", payload: write(`${WORKSPACE}/a`) }, low, yes),
  );

  const mediumTryingToOptOut = {
    name: "s",
    risk_level: "medium",
    requires_human_approval: false,
    allowed_tools: ["read_file"],
    allowed_directories: [WORKSPACE],
  };
  check(
    "a medium skill cannot lower the bar with its own flag",
    !(await allow({ tool: "read_file", payload: write(`${WORKSPACE}/a`) }, mediumTryingToOptOut, undefined)),
  );
}

// ── payload shape ──────────────────────────────────────────────────────────
console.log("\n\x1b[1mpayload shape\x1b[0m");

{
  const skill = { name: "s", risk_level: "low", allowed_tools: ["write_file"], allowed_directories: [WORKSPACE] };
  check(
    "a string payload is refused",
    await refusesWith({ tool: "write_file", payload: "just a string" }, skill, undefined, "malformed_payload"),
  );
  check(
    "an array payload is refused",
    await refusesWith({ tool: "write_file", payload: [1, 2] }, skill, undefined, "malformed_payload"),
  );
  check(
    "a null payload is refused",
    await refusesWith({ tool: "write_file", payload: null }, skill, undefined, "malformed_payload"),
  );
  check(
    "a missing payload is refused",
    await refusesWith({ tool: "write_file" }, skill, undefined, "malformed_payload"),
  );
  check(
    "a payload carrying __proto__ is refused",
    await refusesWith(
      { tool: "write_file", payload: JSON.parse('{"__proto__":{"admin":true}}') },
      skill,
      undefined,
      "malformed_payload",
    ),
  );
  check(
    "a non-string path is refused",
    await refusesWith({ tool: "write_file", payload: { path: 42, content: "x" } }, skill, undefined, "path_not_allowed"),
  );
  check("isPlainObject rejects an array", !_internal.isPlainObject([]));
  check("isPlainObject accepts a plain object", _internal.isPlainObject({ a: 1 }));
}

console.log(`\n${fail === 0 ? "\x1b[32m✅" : "\x1b[31m❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
