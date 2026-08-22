/**
 * Durable transcript boundary for the reference CLI.
 *
 * The CLI still owns presentation and the interactive loop. This module owns
 * only the transcript archive and restart continuity: select/create the active
 * CLI conversation, rebuild completed history, append completed messages, and
 * rotate to a fresh conversation on /clear.
 *
 * It deliberately does NOT provide long-term memory, semantic retrieval,
 * provider sessions, or in-flight model replay. A turn enters restored history
 * only after both its user and assistant messages were durably recorded.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createSqliteTranscriptStore } from "../../adapters/transcripts/sqlite-transcript-store.js";
import type { ChatMessage } from "../../core/domain/types.js";
import type {
  ConversationRecord,
  MessageRecord,
  TranscriptStore,
} from "../../core/ports/transcript-store.js";

const INTERACTIVE_SURFACE = "cli";
const ONCE_SURFACE = "cli-once";
const CLI_TITLE = "CLI conversation";
const PROMPT_BUNDLE_PERSONA = "prompt-bundle";
const RUNTIME_SELECTED_PROVIDER = "runtime-selected";

/** Restoration may retain more than the model's recent-window budget. */
export const RESTORED_CLI_HISTORY_MAX_MESSAGES = 80;

export interface OpenCliTranscriptOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly newId: (prefix: string) => string;
  readonly nowIso: () => string;
  /**
   * Optional creation-time provider metadata. It is evidence only, never a
   * routing authority. The CLI composition may refine this in a later provider
   * reliability phase; absence is represented explicitly rather than guessed.
   */
  readonly providerProfileId?: string;
  /**
   * Application-data directory supplied by the real process boundary.
   * Omit it only for an intentionally ephemeral embedded/test session.
   */
  readonly dataDir?: string;
  /** One-shot invocations are isolated and never become interactive resume state. */
  readonly oneShot?: boolean;
}

export interface CliTranscriptSession {
  readonly history: readonly ChatMessage[];
  readonly conversationId: string;
  persistUser(turnId: string, text: string): Promise<void>;
  persistAssistant(turnId: string, text: string): Promise<void>;
  /** Preserve the old transcript, archive it, and begin a fresh conversation. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

function restoredCompletedHistory(messages: readonly MessageRecord[]): ChatMessage[] {
  const pendingUser = new Map<string, string>();
  const history: ChatMessage[] = [];

  for (const message of messages) {
    if (message.state !== "delivered" || message.externalTurnId === undefined) continue;

    if (message.role === "user") {
      pendingUser.set(message.externalTurnId, message.text);
      continue;
    }

    const userText = pendingUser.get(message.externalTurnId);
    if (userText === undefined) continue;
    history.push({ role: "user", text: userText });
    history.push({ role: "assistant", text: message.text });
    pendingUser.delete(message.externalTurnId);
  }

  return history.slice(-RESTORED_CLI_HISTORY_MAX_MESSAGES);
}

async function createConversation(
  store: TranscriptStore,
  surface: string,
  providerProfileId: string,
  nowIso: string,
): Promise<ConversationRecord> {
  return store.createConversation(
    {
      title: CLI_TITLE,
      personaId: PROMPT_BUNDLE_PERSONA,
      providerProfileId,
      surface,
    },
    nowIso,
  );
}

/**
 * Open the CLI transcript archive and reconstruct the active conversation.
 *
 * Interactive mode resumes the newest non-archived CLI conversation. One-shot
 * mode always creates its own conversation so a scripting invocation can never
 * silently alter later interactive context.
 */
export async function openCliTranscriptSession(
  options: OpenCliTranscriptOptions,
): Promise<CliTranscriptSession> {
  let path = ":memory:";
  if (options.dataDir !== undefined) {
    await mkdir(options.dataDir, { recursive: true });
    path = join(options.dataDir, "transcripts.db");
  }

  const store = createSqliteTranscriptStore({ path, newId: options.newId });
  const providerProfileId = options.providerProfileId ?? RUNTIME_SELECTED_PROVIDER;

  let conversation: ConversationRecord;
  let history: ChatMessage[];

  try {
    if (options.oneShot === true) {
      conversation = await createConversation(
        store,
        ONCE_SURFACE,
        providerProfileId,
        options.nowIso(),
      );
      history = [];
    } else {
      const conversations = await store.listConversations(false);
      const existing = conversations.find((candidate) => candidate.surface === INTERACTIVE_SURFACE);
      conversation = existing ?? await createConversation(
        store,
        INTERACTIVE_SURFACE,
        providerProfileId,
        options.nowIso(),
      );
      history = restoredCompletedHistory(await store.listMessages(conversation.id));
    }
  } catch (error) {
    await store.close();
    throw error;
  }

  let closed = false;

  return {
    get history() {
      return history;
    },
    get conversationId() {
      return conversation.id;
    },
    async persistUser(turnId: string, text: string): Promise<void> {
      await store.appendMessage(
        {
          conversationId: conversation.id,
          role: "user",
          text,
          state: "delivered",
          externalTurnId: turnId,
        },
        options.nowIso(),
      );
    },
    async persistAssistant(turnId: string, text: string): Promise<void> {
      await store.appendMessage(
        {
          conversationId: conversation.id,
          role: "assistant",
          text,
          state: "delivered",
          externalTurnId: turnId,
        },
        options.nowIso(),
      );
      // Rebuild from durable rows rather than maintaining a second parallel
      // truth in memory. Restart and in-process semantics therefore match.
      history = restoredCompletedHistory(await store.listMessages(conversation.id));
    },
    async clear(): Promise<void> {
      if (options.oneShot === true) return;
      await store.archiveConversation(conversation.id, true, options.nowIso());
      conversation = await createConversation(
        store,
        INTERACTIVE_SURFACE,
        providerProfileId,
        options.nowIso(),
      );
      history = [];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await store.close();
    },
  };
}
