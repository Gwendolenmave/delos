/**
 * The Wave 7 provider contract.
 *
 * Where `model-provider.ts` is the minimal v0.1 port the turn service
 * consumes, this port is what the provider REGISTRY produces: a richer result
 * carrying protocol identity, usage and observed capabilities, and a failure
 * shape whose every field is safe to show a user.
 *
 * Core owns these types so that adapters depend on core and never the other
 * way around. A bridge in core/services maps this contract down onto the
 * legacy `ModelProvider` port, which keeps the existing turn service - and
 * every test that binds it - unchanged.
 */

import type { ModelRequest } from "./model-provider.js";

/** Provider-neutral public error categories. */
export const PROVIDER_ERROR_CODES = [
  /** The profile itself is unusable: bad URL, bad header, bad combination. */
  "profile-invalid",
  /** No credential is configured where one is required. */
  "credential-missing",
  /** A credential is configured but cannot be read right now. */
  "credential-unavailable",
  /** The provider rejected the credential. */
  "authentication-failed",
  /** The credential is valid but not allowed to do this. */
  "permission-denied",
  /** The provider does not recognise the requested model or path. */
  "model-not-found",
  /** The provider applied a rate limit. */
  "rate-limited",
  /** The deadline elapsed before a complete response arrived. */
  "timeout",
  /** The caller cancelled the request. */
  "cancelled",
  /** The provider could not be reached at all. */
  "connection-failed",
  /** The exchange happened but violated the protocol's own rules. */
  "protocol-error",
  /**
   * The profile pins its model and the reply either evidenced a DIFFERENT
   * served model or carried no evidence at all. Pinning means silence is
   * not acceptance.
   */
  "model-mismatch",
  /** A success status carried a body that could not be used. */
  "malformed-response",
  /** The provider reported an error of its own. */
  "provider-error",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type Retryable = "yes" | "no" | "unknown";

/**
 * A failure whose every field is safe to surface.
 *
 * The message has passed through redaction before this object exists; nothing
 * here may carry a credential, a raw header set, a request body or a raw
 * provider response.
 */
export interface ProviderFailure {
  readonly code: ProviderErrorCode;
  readonly providerKind: string;
  /** Safe user-facing sentence. Already redacted. */
  readonly message: string;
  readonly retryable: Retryable;
  /** Present when an HTTP status is what categorised the failure. */
  readonly httpStatus?: number;
}

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * What a successful turn produces.
 *
 * `protocol` names the wire protocol actually spoken - "openai-responses",
 * "openai-chat-completions", "anthropic-messages" - because "which provider
 * kind was configured" and "what was actually said on the wire" are different
 * facts and diagnostics need the second one.
 *
 * `capabilitiesObserved` records only what this exchange actually evidenced.
 * Unknown remains absent rather than guessed.
 */
export interface ProviderResult {
  readonly text: string;
  readonly requestedModel: string;
  readonly servedModel?: string;
  readonly usage?: ProviderUsage;
  readonly protocol: string;
  readonly capabilitiesObserved: {
    readonly streaming?: boolean;
    readonly cancellation?: boolean;
  };
  /** Allowlisted, non-sensitive fields only - never the raw response. */
  readonly rawProviderMetadata?: Readonly<Record<string, unknown>>;
}

export type ProviderTurn =
  | { readonly ok: true; readonly result: ProviderResult }
  | { readonly ok: false; readonly error: ProviderFailure };

export interface GenerateOptions {
  /** Caller cancellation. Composed with the profile's timeout by adapters. */
  readonly signal?: AbortSignal;
}

/**
 * What the registry hands out.
 *
 * `generate` returns failures as values rather than throwing: a provider
 * failing is an expected outcome with a user-facing rendering, not an
 * exception. Only genuine programmer error throws.
 */
export interface DelosProvider {
  readonly profileId: string;
  readonly kind: string;
  readonly protocol: string;
  generate(request: ModelRequest, options?: GenerateOptions): Promise<ProviderTurn>;
}
