/**
 * Provider-neutral model contract. Core depends only on this shape; concrete
 * providers live under adapters/ and are injected by the composition root.
 *
 * v0.1 keeps this surface deliberately small. A port must not declare
 * capabilities the runtime cannot honour, and must not describe failure modes
 * no real adapter can produce - a contract that describes things which do not
 * exist is a contract that lies.
 */
import type { ChatMessage } from "../domain/types.js";

export interface ModelRequest {
  /** Stable conversation identity, for providers that keep server-side state. */
  conversationId: string;
  /** Stable turn identity, so a provider can make its turn markers idempotent. */
  turnId: string;
  /**
   * Static authority prompt. Providers must carry this as system
   * instructions, never as a user message.
   *
   * This carries **trusted application-level instructions and deterministic
   * metadata only** - the assembled prompt sections and facts the runtime
   * itself established, such as the current time.
   *
   * It is NOT a general destination for "everything that is not dialogue".
   * Material the user controls, material a tool or document returned, and
   * anything retrieved from outside must never be promoted to system
   * authority merely because it did not fit the message list. Anything a
   * model should treat as claims rather than instructions belongs in
   * `messages` with a role, or in a later turn-service contract designed for
   * untrusted content.
   */
  systemPrompt: string;
  /**
   * The conversation, in order, with roles preserved.
   *
   * The LAST element is the current user input for this turn. Recent history
   * precedes it. There is no separate "current text" field and no untyped
   * "dynamic prompt" blob: everything the model reads as dialogue carries an
   * explicit role, so a caller cannot accidentally present assistant text as
   * user text, or history as a fresh instruction.
   *
   * Deeply readonly: the array cannot be reordered and `ChatMessage`'s own
   * fields are readonly too, so an adapter cannot rewrite the caller's
   * history in place.
   */
  readonly messages: readonly ChatMessage[];
  /**
   * Explicit model override for THIS request. Absent means the provider
   * applies its configured default. Never derived from generated text.
   */
  model?: string | null;
}

/**
 * Failure categories every adapter can actually distinguish and map onto.
 *
 * These are transport-neutral on purpose. An HTTP adapter maps status codes
 * and socket errors onto them; a future subprocess adapter maps exit codes and
 * spawn errors onto the same set. No member here names a mechanism.
 */
export const MODEL_ERROR_KINDS = [
  /** Missing or malformed local configuration: no endpoint, no model, no key. */
  "configuration",
  /** The provider rejected the credential: absent, invalid, or expired. */
  "authentication",
  /** The provider refused for quota or rate reasons; retriable after a wait. */
  "rate_limit",
  /** No answer within the caller's deadline. */
  "timeout",
  /** The provider could not be reached at all: DNS, connection, TLS, socket. */
  "network",
  /** Reached and answered, but the answer did not fit the expected shape. */
  "invalid_response",
  /** Reached and answered with an error of its own that fits no category above. */
  "provider_error",
  /** The caller cancelled the turn. */
  "cancelled",
] as const;

/**
 * Derived from the runtime constant above, which is the single source of
 * truth. Tests import `MODEL_ERROR_KINDS` rather than restating the list, so
 * adding a member without updating the rules cannot pass unnoticed.
 */
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

export type ModelResult =
  | {
      ok: true;
      text: string;
      /**
       * Served-model identity as reported by provider metadata. null or
       * absent means unknown. Generated prose is never a source for this
       * field - a model naming itself in its own output is not evidence.
       */
      servedModel?: string | null;
    }
  | { ok: false; errorKind: ModelErrorKind; detail: string };

export interface ModelProvider {
  /** Short provider label for transcripts and status lines. */
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResult>;
  close?(): Promise<void> | void;
}
