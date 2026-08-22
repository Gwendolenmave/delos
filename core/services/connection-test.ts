/**
 * The provider connection test.
 *
 * Uses the REAL adapter contract - the same generate path a conversation
 * uses - with the smallest message the protocol accepts, so a passing test is
 * evidence about the path that will actually be used, not about a lighter one
 * that happens to share a hostname. A mere TCP connection proves reachability
 * of a socket, not that a credential works, a model exists, or a protocol is
 * spoken; none of that shortcut evidence is accepted here.
 *
 * The probe's response text is deliberately dropped. A connection test is not
 * a conversation, and its output must never appear in one.
 */

import type { DelosProvider, ProviderFailure } from "../ports/provider.js";

export interface ConnectionTestSuccess {
  readonly ok: true;
  readonly profileId: string;
  /** The profile validated and a credential (where required) resolved. */
  readonly credentialResolved: true;
  /** The endpoint accepted the request and answered the protocol. */
  readonly requestAccepted: true;
  readonly requestedModel: string;
  /** Present only when the provider's metadata evidenced it. */
  readonly servedModel?: string;
  readonly latencyMs: number;
  readonly protocol: string;
}

export interface ConnectionTestFailure {
  readonly ok: false;
  readonly profileId: string;
  readonly latencyMs: number;
  readonly error: ProviderFailure;
}

export type ConnectionTestReport = ConnectionTestSuccess | ConnectionTestFailure;

/** Injected clock so tests are deterministic. */
export interface ConnectionTestOptions {
  readonly now?: () => number;
}

/** The smallest safe probe: one short user message, no persona, no history. */
const PROBE_SYSTEM = "You are being connection-tested. Reply with a single short word.";
const PROBE_TEXT = "ping";

export async function testProviderConnection(
  provider: DelosProvider,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTestReport> {
  const now = options.now ?? Date.now;
  const started = now();

  const turn = await provider.generate({
    conversationId: "connection-test",
    turnId: `connection-test-${started}`,
    systemPrompt: PROBE_SYSTEM,
    messages: [{ role: "user", text: PROBE_TEXT }],
  });

  const latencyMs = Math.max(0, now() - started);

  if (!turn.ok) {
    return { ok: false, profileId: provider.profileId, latencyMs, error: turn.error };
  }

  // The reply text is discarded here, on purpose. Only evidence about the
  // connection survives.
  return {
    ok: true,
    profileId: provider.profileId,
    credentialResolved: true,
    requestAccepted: true,
    requestedModel: turn.result.requestedModel,
    ...(turn.result.servedModel === undefined ? {} : { servedModel: turn.result.servedModel }),
    latencyMs,
    protocol: turn.result.protocol,
  };
}
