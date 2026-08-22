/**
 * Platform-neutral domain types for the Delos v0.1 vertical slice.
 * Nothing in this file may reference a concrete provider, transport, or SDK.
 */

/**
 * One section of the assistant's identity.
 *
 * Source-agnostic on purpose. A section may come from a file on disk, an
 * editor in a user interface, an imported profile bundle, a synced folder, or
 * something a user writes. None of those should have to invent a file path to
 * construct one - so no path appears here. Implementations that DO have
 * filesystem provenance extend this type on their own side.
 */
export interface PromptSection {
  /**
   * Logical section identifier supplied by the identity source. Stable and
   * meaningful to that source; core treats it as an opaque label.
   */
  readonly name: string;
  /** SHA-256 hex digest of the section's bytes as the source read them. */
  readonly sha256: string;
  /** Verbatim section content. */
  readonly content: string;
}

export interface PromptBundle {
  readonly sections: readonly PromptSection[];
}

export type ChatRole = "user" | "assistant";

/**
 * One turn of dialogue.
 *
 * Every field is `readonly`. A `readonly ChatMessage[]` alone would only stop
 * an adapter reordering the array - it could still rewrite `message.text` in
 * place and change the caller's history. Freezing the fields is what actually
 * makes a message safe to hand to a provider.
 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly text: string;
  /**
   * Stable message id, when known. Optional: simple call sites build
   * {role, text} only. Carried through unchanged by every v0.1 module - the
   * recent-context strategy selects and preserves messages, it does not
   * render identifiers into the prompt, and nothing in v0.1 does.
   */
  readonly messageId?: string;
  /** ISO-8601 instant the message was recorded, when known. */
  readonly atIso?: string;
}

export interface TurnSuccess {
  ok: true;
  replyText: string;
}

export interface TurnFailure {
  ok: false;
  /** Safe, user-facing description. Never raw stderr or a stack trace. */
  failure: string;
}

export type TurnOutcome = TurnSuccess | TurnFailure;
