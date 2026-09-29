import { ToolRegistry } from "./capabilities";

/* =============================================================================
   Default profiles
   -----------------------------------------------------------------------------
   The host's catalogue. This is what the *system* knows how to do, and it is
   the only place capabilities are named.

   The agent never receives this. It receives whatever `resolveSurface`
   narrows it down to, which is usually two or three entries from a list like
   this one. That separation is the point: adding a service here grants it to
   nobody, and the first task that asks for it by name is a visible event
   rather than an inherited privilege.

   The scopes below are placeholders — `account:primary` is not a real OAuth
   scope and no credential store exists yet. They are here because a grant
   with no scope is a grant with no limit, and the tests would be testing a
   weaker system than the one this shape implies. When these become real
   scopes, the narrowing logic needs no change: it already intersects them.
   ========================================================================== */

let cached: ToolRegistry | null = null;

/**
 * The built-in registry, built once.
 *
 * Cached because it is immutable in practice and rebuilt on every request it
 * would be a small waste with no benefit — a fresh object each time would
 * suggest the contents could differ per call, and they cannot.
 */
export function defaultRegistry(): ToolRegistry {
  if (cached) return cached;
  cached = new ToolRegistry()
    .register({
      id: "workspace",
      description: "Reading and writing inside the task's own workspace directory.",
      grants: [
        {
          action: "read_file",
          capability: "workspace.read",
          scopes: [],
          risk: "low",
          requiresApproval: false,
          /* Local filesystem, no service behind it. Said explicitly so the
             downscoper does not read its absence from the binding table as
             an oversight. */
          requiresToken: false,
          estimatedCost: 1,
        },
        {
          action: "write_file",
          capability: "workspace.write",
          scopes: [],
          risk: "low",
          requiresApproval: false,
          requiresToken: false,
          estimatedCost: 1,
        },
      ],
    })
    .register({
      id: "mail",
      description: "Reading messages. Sending is high-impact and never self-granted.",
      grants: [
        {
          action: "mail.read",
          capability: "mail.read",
          scopes: ["account:primary"],
          risk: "low",
          requiresApproval: false,
          estimatedCost: 2,
        },
        {
          action: "mail.send",
          capability: "mail.write",
          scopes: ["account:primary"],
          risk: "high",
          requiresApproval: true,
          estimatedCost: 10,
        },
      ],
    })
    .register({
      id: "calendar",
      description: "Inspecting and moving events.",
      grants: [
        {
          action: "calendar.read",
          capability: "calendar.read",
          scopes: ["account:primary"],
          risk: "low",
          requiresApproval: false,
          estimatedCost: 2,
        },
        {
          action: "calendar.write",
          capability: "calendar.write",
          scopes: ["account:primary"],
          risk: "medium",
          requiresApproval: true,
          estimatedCost: 5,
        },
      ],
    })
    .register({
      id: "storage",
      description: "File storage. Writing here is high-impact.",
      grants: [
        {
          action: "storage.read",
          capability: "storage.read",
          scopes: ["account:primary"],
          risk: "medium",
          requiresApproval: false,
          estimatedCost: 3,
        },
        {
          action: "storage.write",
          capability: "storage.write",
          scopes: ["account:primary"],
          risk: "high",
          requiresApproval: true,
          estimatedCost: 15,
        },
      ],
    });
  return cached;
}
