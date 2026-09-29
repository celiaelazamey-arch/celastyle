import type { CredentialBroker, AuthorizationDecision } from "../credential-broker";
import type { EventLedger } from "../event-ledger";

/* =============================================================================
   The broker gate — where a decision becomes evidence
   -----------------------------------------------------------------------------
   The broker exists and is correct. Before this, nothing called it: the
   component was tested, isolated, and unreachable from the live path. This
   is the piece that makes it load-bearing.

   It owns three things that must travel together, because separating them is
   how this goes wrong:

     the connection   — so no caller can talk to the broker except through
                        the gate, and so a decision cannot be made off-path
     the token        — so the worker gets a current token and no caller
                        gets to choose a stale one
     the ledger       — so a decision that was not recorded cannot be acted on

   The worker never holds a credential. It holds a token that names a session
   and an epoch, and the broker releases credentials to nobody — so the worker's
   worst outcome is a refusal, not a leak.

   Two rules that are the whole design:

   1. Fail closed. A broker that cannot be reached has not said yes. The
      transport failure is recorded as a refusal, not retried into a yes.

   2. Never re-mint on a stale token. This is the subtle one, and it is the
      difference between revocation working and revocation being decorative.
      A gate that refreshed its token whenever it saw `stale_epoch` would
      re-establish exactly the authority a revoke just removed — the worker
      would be refused, would ask again, and would be handed a fresh token to
      succeed with. Refreshing is a deliberate act by whoever granted the
      capability, not a self-healing response to being caught.
   ========================================================================== */

export type AuthorizeRequest = {
  action: string;
  /** What is being acted on. Omitted for actions that name no resource. */
  resource?: string;
};

/**
 * The contract the executor depends on.
 *
 * Declared as an object with a named method rather than a bare function
 * type. Two reasons, and the second is not stylistic: a function type is a
 * *call signature*, and the compiler currently installed in this workspace
 * does not check call signatures at all — `implements` against one, and plain
 * assignability to one, both fail on patterns that have been valid TypeScript
 * since 1.x. A named method is checked correctly, so the contract this file
 * offers is one the typecheck can actually verify.
 */
export type Authorizer = {
  authorize(request: AuthorizeRequest): Promise<AuthorizationDecision>;
};

/** The ledger action name. One name, so every broker decision is greppable
 *  and a chain can be filtered down to authorization without reading it all. */
export const AUTHORIZE_ACTION = "broker.authorize";

export type BrokerGateOptions = {
  broker: CredentialBroker;
  ledger: EventLedger;
  sessionId: string;
  /** Mint a token at construction. A token can only be minted for a session
   *  that exists, so the session must be open first. */
  token?: string;
};

export class BrokerGate implements Authorizer {
  private readonly broker: CredentialBroker;
  private readonly ledger: EventLedger;
  private readonly sessionId: string;
  private token: string | undefined;
  private socketPath: string | undefined;

  private constructor(options: BrokerGateOptions) {
    this.broker = options.broker;
    this.ledger = options.ledger;
    this.sessionId = options.sessionId;
    this.token = options.token;
  }

  static async open(options: BrokerGateOptions): Promise<BrokerGate> {
    const token = options.token ?? (await options.broker.mint(options.sessionId)).token;
    return new BrokerGate({ ...options, token });
  }

  /**
   * The environment the worker is given, and nothing else.
   *
   * Two variables. One is an address, one is a capability. Neither is a
   * credential, and a worker that exfiltrates both has stolen the ability to
   * ask questions as this session — which the broker re-authorizes per
   * request, so the stolen token buys an attacker exactly nothing that the
   * epoch does not already take back.
   */
  workerEnv(): Record<string, string> {
    if (!this.token) throw new Error("the gate has no channel token to hand the worker");
    return {
      CELESTYLE_BROKER_SOCKET: this.broker.socketPath,
      CELESTYLE_CHANNEL_TOKEN: this.token,
    };
  }

  /**
   * Ask, then record, then return.
   *
   * The record happens whether the answer was yes or no. A denial that leaves
   * no trace is indistinguishable from an action that was never attempted,
   * and "nobody tried that" is the conclusion an attacker wants an auditor
   * to reach.
   */
  async authorize(request: AuthorizeRequest): Promise<AuthorizationDecision> {
    if (!this.token) {
      return this.record(request, {
        allowed: false,
        code: "no_broker",
        reason: "the gate holds no channel token, so nothing can be authorized",
      });
    }

    const decision = await this.broker.authorize({
      token: this.token,
      action: request.action,
      resource: request.resource,
    });

    return this.record(request, decision);
  }

  private record(
    request: AuthorizeRequest,
    decision: AuthorizationDecision,
  ): AuthorizationDecision {
    this.ledger.append({
      action: AUTHORIZE_ACTION,
      /* The decision, not the token. A ledger is evidence, and evidence that
         contains a live bearer credential stops being evidence and starts
         being a second copy of the secret. */
      payload: {
        session_id: this.sessionId,
        action: request.action,
        resource: request.resource ?? null,
        allowed: decision.allowed,
        ...(decision.allowed
          ? {
              capability: decision.authorization.capability,
              epoch: decision.authorization.epoch,
            }
          : { code: decision.code, reason: decision.reason }),
      },
      /* A denial is recorded as a failed result. The action did not take
         place, and "failed" is the honest word for that — the alternative is
         a third state the chain format does not have, and inventing one to
         make the ledger look tidier would cost more than it buys. */
      verifier_result: decision.allowed ? "success" : "failed",
    });
    return decision;
  }

  /**
   * Replace the channel token, deliberately.
   *
   * Only after an intentional change — a grant, a revoke, a policy edit. The
   * caller has to ask for this. Nothing in the request path calls it, which
   * is the property the revocation tests depend on.
   */
  async refreshToken(): Promise<number> {
    const minted = await this.broker.mint(this.sessionId);
    this.token = minted.token;
    return minted.epoch;
  }
}
