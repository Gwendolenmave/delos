/**
 * The transcript archive port.
 *
 * A transcript archive and nothing more: what was said, by whom, through
 * which surface, with which persona and provider, in what order, and what
 * state each assistant turn is in. It is NOT a memory system - no semantic
 * retrieval, no summarisation, no governance - and the port's shape refuses
 * to grow those by accident: every method is a literal read or a literal
 * state transition.
 *
 * What may never enter the store, by contract: secrets, raw auth headers,
 * environment dumps, hidden reasoning, or content discarded by containment.
 * The containment RECORD (reason/bytes/hash) is storable; the content is not,
 * because it no longer exists by the time this port is reached.
 */

import type { ContainmentRecord } from "../services/output-containment.js";

// --- conversations -----------------------------------------------------------

export interface ConversationRecord {
  readonly id: string;
  readonly title: string;
  readonly personaId: string;
  readonly providerProfileId: string;
  /** Variant ids the user has enabled/disabled for this conversation. */
  readonly manualEnabled: readonly string[];
  readonly manualDisabled: readonly string[];
  /** The surface that created it: "cli", "web", "telegram", ... */
  readonly surface: string;
  readonly archived: boolean;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

// --- messages ----------------------------------------------------------------

/**
 * Durable assistant-turn state machine. A user message is stored as
 * "completed" immediately; an assistant message walks these states, and every
 * transition is persisted BEFORE the action it describes is taken, which is
 * what makes crash recovery honest.
 */
export const TURN_STATES = [
  "received",
  "accepted",
  "model-pending",
  "model-completed",
  "delivery-pending",
  "delivered",
  "failed-before-model",
  "failed-after-model",
  "cancelled",
] as const;
export type TurnState = (typeof TURN_STATES)[number];

export interface MessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  /** Displayable text only - post-containment, post-sanitiser. */
  readonly text: string;
  /** Monotonic per-conversation ordering, assigned by the store. */
  readonly ordinal: number;
  readonly state: TurnState;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  /** For assistant turns: which external turn produced it. */
  readonly externalTurnId?: string;
  readonly containment?: readonly ContainmentRecord[];
}

// --- external turns ----------------------------------------------------------

/**
 * One inbound request from a surface, with the stable identity that makes
 * retries idempotent: the same (surface, externalConversationKey,
 * externalTurnKey) is the SAME turn, however many times it arrives.
 */
export interface ExternalTurnRecord {
  readonly id: string;
  readonly surface: string;
  readonly externalConversationKey: string;
  readonly externalTurnKey: string;
  readonly conversationId: string;
  readonly state: TurnState;
  /** The completed assistant message, once one exists. */
  readonly assistantMessageId?: string;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

// --- provider observations ---------------------------------------------------

/** How a capability/model fact was learned. Model prose is NOT a source. */
export const EVIDENCE_SOURCES = [
  "provider-metadata",
  "protocol-behaviour",
  "configuration",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface ProviderObservation {
  readonly id: string;
  readonly profileId: string;
  readonly configuredModel: string;
  readonly requestedModel: string;
  /** As evidenced by provider metadata; absent = unknown, never guessed. */
  readonly servedModel?: string;
  readonly protocol: string;
  readonly capability?: string;
  readonly evidenceSource: EvidenceSource;
  readonly atIso: string;
}

// --- the port ----------------------------------------------------------------

export class TranscriptStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid"
      | "conflict"
      | "corrupt"
      | "migration_failed"
      | "invalid_transition",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptStoreError";
  }
}

export interface CreateConversationInput {
  readonly title: string;
  readonly personaId: string;
  readonly providerProfileId: string;
  readonly surface: string;
}

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly state: TurnState;
  readonly externalTurnId?: string;
  readonly containment?: readonly ContainmentRecord[];
}

export interface TranscriptStore {
  // conversations
  createConversation(input: CreateConversationInput, nowIso: string): Promise<ConversationRecord>;
  getConversation(id: string): Promise<ConversationRecord>;
  listConversations(includeArchived?: boolean): Promise<readonly ConversationRecord[]>;
  renameConversation(id: string, title: string, nowIso: string): Promise<void>;
  setConversationVariants(
    id: string,
    manualEnabled: readonly string[],
    manualDisabled: readonly string[],
    nowIso: string,
  ): Promise<void>;
  archiveConversation(id: string, archived: boolean, nowIso: string): Promise<void>;
  /** Deletes the conversation AND its messages and external turns. */
  deleteConversation(id: string): Promise<void>;
  /** JSON export of one conversation: records only, nothing invented. */
  exportConversation(id: string): Promise<string>;
  /**
   * Deterministic logical snapshot of every table for backup: stable key
   * order, stable row order, no volatile fields. Same state, same bytes.
   */
  exportEverything(): Promise<string>;
  /**
   * Restore a snapshot inside ONE transaction. "replace" empties the tables
   * first; "merge-skip" keeps existing rows on id collision. A duplicate id
   * inside the snapshot, an unsupported schema, or a dangling reference
   * rolls the WHOLE import back - the store is never left half-restored.
   */
  importEverything(
    snapshot: string,
    policy: "replace" | "merge-skip",
  ): Promise<{ conversations: number; messages: number; externalTurns: number; observations: number }>;

  // messages
  appendMessage(input: AppendMessageInput, nowIso: string): Promise<MessageRecord>;
  /** Valid state transitions only; anything else is invalid_transition. */
  setMessageState(id: string, state: TurnState, nowIso: string): Promise<void>;
  setMessageText(id: string, text: string, nowIso: string): Promise<void>;
  listMessages(conversationId: string): Promise<readonly MessageRecord[]>;

  // external turns
  /**
   * Find-or-create by stable identity. Returns the EXISTING record when the
   * same (surface, conversationKey, turnKey) has been seen before - this is
   * the idempotency primitive everything else builds on.
   */
  beginExternalTurn(
    surface: string,
    externalConversationKey: string,
    externalTurnKey: string,
    conversationId: string,
    nowIso: string,
  ): Promise<{ record: ExternalTurnRecord; existed: boolean }>;
  getExternalTurn(id: string): Promise<ExternalTurnRecord>;
  setExternalTurnState(
    id: string,
    state: TurnState,
    nowIso: string,
    assistantMessageId?: string,
  ): Promise<void>;
  /**
   * Turns needing recovery: every non-terminal state, plus failed-after-model
   * - the one "failure" that is really a stored reply awaiting a delivery
   * retry (its only legal edge is back to delivery-pending).
   */
  listRecoverableTurns(): Promise<readonly ExternalTurnRecord[]>;

  /** Read-only health probe: engine integrity plus the schema version. */
  integrityCheck(): Promise<{ ok: boolean; schemaVersion: number; detail: string }>;

  // provider observations
  recordObservation(observation: Omit<ProviderObservation, "id">): Promise<ProviderObservation>;
  listObservations(profileId: string): Promise<readonly ProviderObservation[]>;

  close(): Promise<void>;
}

/**
 * The legal state machine. Persisted transitions must follow these edges;
 * everything else is a bug surfaced as invalid_transition rather than data.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  received: ["accepted", "failed-before-model", "cancelled"],
  accepted: ["model-pending", "failed-before-model", "cancelled"],
  "model-pending": ["model-completed", "failed-before-model", "cancelled"],
  "model-completed": ["delivery-pending", "failed-after-model"],
  "delivery-pending": ["delivered", "failed-after-model"],
  delivered: [],
  "failed-before-model": [],
  "failed-after-model": ["delivery-pending"], // delivery retry, never regeneration
  cancelled: [],
};

export function assertTransition(from: TurnState, to: TurnState): void {
  if (!TURN_TRANSITIONS[from].includes(to)) {
    throw new TranscriptStoreError(
      "invalid_transition",
      `An external turn cannot move from "${from}" to "${to}".`,
    );
  }
}
