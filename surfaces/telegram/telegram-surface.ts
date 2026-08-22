/**
 * The Telegram surface: Bot API long polling in front of the same runtime
 * every other surface uses.
 *
 * Nothing here is a second Delos. Provider selection, persona resolution,
 * situations, transcripts, idempotency and delivery recovery are the same
 * machinery the daemon composes; this module translates Telegram updates
 * into external turns. The (chat, update) pair is the external identity, so
 * Telegram's at-least-once delivery meets the coordinator's exactly-once
 * model calls head on.
 *
 * Delivery goes THROUGH the coordinator, not around it: this surface builds
 * its own turn coordinator whose `deliver` callback is sendMessage, which is
 * what makes crash recovery redeliver a generated-but-unsent reply after a
 * restart, with zero model calls.
 *
 * Security defaults, all enforced here: disabled until explicitly enabled;
 * direct messages only; a user-id allowlist with deny-by-default; bot
 * senders ignored; the token resolved through the secret store per call and
 * never logged, never returned by any API, and redacted from every error
 * this module can surface. An existing webhook is DETECTED and reported -
 * long polling refuses to fight it - and it is never deleted without the
 * user explicitly asking.
 */

import type { SecretStore } from "../../core/ports/secret-store.js";
import type { TranscriptStore } from "../../core/ports/transcript-store.js";
import type { ModelProvider, ModelRequest } from "../../core/ports/model-provider.js";
import { rm } from "node:fs/promises";

import {
  createTurnCoordinator,
  type DeliveredTurnNotice,
} from "../../core/services/turn-coordinator.js";
import { createRedactor, type Redactor } from "../../core/services/redaction.js";
import { segmentReply } from "../../core/services/reply-segmentation.js";
import { MAX_ATTACHMENT_BYTES, type SttAdapter } from "../../core/ports/attachment.js";
import { AttachmentError, stageAttachment } from "../../adapters/attachments/attachment-intake.js";

export interface TelegramConfig {
  readonly enabled: boolean;
  /** Secret REFERENCE for the bot token; never the token. */
  readonly tokenSecretId: string;
  /** Telegram user ids allowed to talk to this bot. Deny by default. */
  readonly allowedUserIds: readonly number[];
  readonly defaultProviderProfileId: string;
  readonly defaultPersonaId: string;
  readonly defaultVariants: readonly string[];
}

export interface TelegramStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly configured: boolean;
  /** Webhook conflict detected: long polling cannot start until it is removed. */
  readonly webhookConflict?: string;
  readonly lastError?: string;
}

export interface TelegramSurfaceOptions {
  readonly config: TelegramConfig;
  readonly secretStore: SecretStore;
  readonly store: TranscriptStore;
  /** The provider resolved from the configured default profile. */
  readonly provider: ModelProvider;
  /**
   * The same request assembly the daemon uses - persona resolution, variants,
   * situations, trust-ordered context and optional Mnemosyne context. The
   * durable turn id lets composition persist metadata-only sidecar receipts
   * before the provider is called.
   */
  readonly buildRequest: (
    conversationId: string,
    turnId: string,
    userText: string,
    durableTurnId: string,
  ) => Promise<ModelRequest>;
  /** Optional orthogonal post-delivery lane (for example memory decisions). */
  readonly onTurnDelivered?: (notice: DeliveredTurnNotice) => Promise<void> | void;
  readonly nowIso: () => string;
  /**
   * Containment + sanitising applied to model text at the delivery boundary,
   * exactly as the daemon applies it before its own API responses. The
   * canonical transcript keeps the stored text; only the wire copy is
   * rendered. Defaults to identity.
   */
  readonly renderForDelivery?: (text: string) => string;
  /**
   * Voice-note support (13.1): a pluggable LOCAL transcriber plus a
   * directory for atomically staged downloads. Both absent by default -
   * voice input is then truthfully unsupported, never silently dropped.
   */
  readonly stt?: SttAdapter;
  readonly attachmentDir?: string;
  readonly maxAttachmentBytes?: number;
  /** Defaults to the official origin; tests point it at a loopback server. */
  readonly apiOrigin?: string;
  readonly fetchImpl?: typeof fetch;
  /** Poll timeout seconds for getUpdates. Small in tests. */
  readonly pollTimeoutSeconds?: number;
}

export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_MAX_SEGMENTS = 12;

/**
 * Split for Telegram's limit WITHOUT altering the canonical transcript -
 * the shared segmentation service does the work (fence preservation,
 * paragraph/sentence boundaries, tiny-fragment merging, surrogate safety,
 * visible truncation past the segment cap).
 */
export function splitForTelegram(text: string): readonly string[] {
  return segmentReply(text, {
    maxSegmentLength: TELEGRAM_MESSAGE_LIMIT,
    maxSegments: TELEGRAM_MAX_SEGMENTS,
  });
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly from?: { readonly id: number; readonly is_bot: boolean };
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
    /** Voice note metadata; the bytes come through getFile separately. */
    readonly voice?: { readonly file_id: string; readonly file_size?: number };
    /** Photo input: refused truthfully until a provider evidences images. */
    readonly photo?: readonly { readonly file_id: string }[];
  };
}

export interface TelegramSurface {
  status(): TelegramStatus;
  /** Validate the token and check for a webhook conflict. Never logs the token. */
  probe(): Promise<TelegramStatus>;
  start(): Promise<TelegramStatus>;
  stop(): Promise<void>;
  /** Process one batch of updates. Exposed so tests drive polling directly. */
  pollOnce(): Promise<number>;
  /** Retry delivery of generated-but-unsent replies. Runs at start() too. */
  recoverDeliveries(): Promise<number>;
  /**
   * Deliver one runtime-initiated text (a proactive message) to a chat this
   * bot already talks to. Same splitting, same redaction; the caller owns
   * transcript bookkeeping.
   */
  sendText(chatId: number, text: string): Promise<void>;
}

export function createTelegramSurface(options: TelegramSurfaceOptions): TelegramSurface {
  const { config, secretStore, store } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiOrigin = options.apiOrigin ?? "https://api.telegram.org";

  let running = false;
  let stopping = false;
  let webhookConflict: string | undefined;
  let lastError: string | undefined;
  let offset: number | undefined;
  let loop: Promise<void> | undefined;

  // The surface's own coordinator: delivery IS sendMessage, so the durable
  // turn state machine and restart recovery govern Telegram replies exactly
  // as they govern every other surface.
  const coordinator = createTurnCoordinator({
    store,
    provider: options.provider,
    nowIso: options.nowIso,
    deliver: async (_surface, conversationKey, text) => {
      const rendered = options.renderForDelivery === undefined ? text : options.renderForDelivery(text);
      await send(Number(conversationKey), rendered);
    },
    ...(options.onTurnDelivered === undefined
      ? {}
      : { onDelivered: options.onTurnDelivered }),
  });

  async function token(): Promise<{ value: string; redactor: Redactor }> {
    const lookup = await secretStore.get(config.tokenSecretId);
    if (!lookup.found) {
      throw new Error(`The Telegram bot token is not available: ${lookup.detail}`);
    }
    return { value: lookup.value, redactor: createRedactor({ values: [lookup.value] }) };
  }

  async function api(method: string, body?: unknown): Promise<unknown> {
    const { value, redactor } = await token();
    let response: Response;
    try {
      response = await fetchImpl(`${apiOrigin}/bot${value}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      // The failure may embed the URL, which embeds the token. Rebuild the
      // message from scratch and still pass it through the redactor.
      throw new Error(redactor.text(`Telegram API unreachable for ${method}.`));
    }
    const parsed = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };
    if (parsed.ok !== true) {
      throw new Error(redactor.text(`Telegram ${method} failed: ${parsed.description ?? response.status}`));
    }
    return parsed.result;
  }

  async function probe(): Promise<TelegramStatus> {
    webhookConflict = undefined;
    lastError = undefined;
    try {
      await api("getMe");
      const info = (await api("getWebhookInfo")) as { url?: string };
      if (typeof info.url === "string" && info.url.length > 0) {
        webhookConflict =
          "A webhook is registered for this bot. Long polling cannot start " +
          "until it is removed; Delos will not remove it without you.";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Telegram probe failed.";
    }
    return status();
  }

  function status(): TelegramStatus {
    return {
      enabled: config.enabled,
      running,
      configured: config.tokenSecretId.length > 0 && config.allowedUserIds.length > 0,
      ...(webhookConflict === undefined ? {} : { webhookConflict }),
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  async function conversationFor(chatId: number): Promise<string> {
    // The stable per-chat conversation IS the persistent chat mapping. It is
    // stored in the transcript database, so it survives restarts.
    const conversations = await store.listConversations(false);
    const existing = conversations.find(
      (c) => c.surface === "telegram" && c.title === `Telegram chat ${chatId}`,
    );
    if (existing !== undefined) return existing.id;
    const created = await store.createConversation(
      {
        title: `Telegram chat ${chatId}`,
        personaId: config.defaultPersonaId,
        providerProfileId: config.defaultProviderProfileId,
        surface: "telegram",
      },
      options.nowIso(),
    );
    if (config.defaultVariants.length > 0) {
      await store.setConversationVariants(created.id, config.defaultVariants, [], options.nowIso());
    }
    return created.id;
  }

  async function send(chatId: number, text: string): Promise<void> {
    for (const part of splitForTelegram(text)) {
      await api("sendMessage", { chat_id: chatId, text: part });
    }
  }

  async function handleCommand(chatId: number, command: string): Promise<void> {
    const conversationId = await conversationFor(chatId);
    switch (command) {
      case "/start":
        await send(
          chatId,
          "This is your local Delos. Messages here run on your own machine " +
            "through your configured provider. /new starts a fresh " +
            "conversation, /status shows the runtime, /persona and /variants " +
            "show what is active.",
        );
        return;
      case "/new": {
        const conversation = await store.getConversation(conversationId);
        await store.archiveConversation(conversationId, true, options.nowIso());
        await send(chatId, `Archived "${conversation.title}". The next message starts fresh.`);
        return;
      }
      case "/status": {
        const conversation = await store.getConversation(conversationId);
        await send(
          chatId,
          `persona: ${conversation.personaId}\nprovider: ${conversation.providerProfileId}\n` +
            `messages: ${(await store.listMessages(conversationId)).length}`,
        );
        return;
      }
      case "/persona": {
        const conversation = await store.getConversation(conversationId);
        await send(chatId, `Active persona: ${conversation.personaId}`);
        return;
      }
      case "/variants": {
        const conversation = await store.getConversation(conversationId);
        await send(
          chatId,
          `enabled: ${conversation.manualEnabled.join(", ") || "(none)"}\n` +
            `disabled: ${conversation.manualDisabled.join(", ") || "(none)"}`,
        );
        return;
      }
      default:
        await send(chatId, "Commands: /start /new /status /persona /variants");
    }
  }

  async function runUserTurn(chatId: number, updateId: number, userText: string): Promise<void> {
    const conversationId = await conversationFor(chatId);
    const outcome = await coordinator.submit({
      surface: "telegram",
      externalConversationKey: String(chatId),
      externalTurnKey: `update-${updateId}`,
      conversationId,
      userText,
      buildRequest: (text, durableTurnId) =>
        options.buildRequest(conversationId, `update-${updateId}`, text, durableTurnId),
    });

    // completed: the coordinator's deliver callback already sent the reply
    // (or, reused, sent it on an earlier attempt - a redelivered update must
    // not produce a second copy). failed after-model: the reply is stored and
    // recoverDeliveries() will retry it. failed before-model: tell the user
    // honestly, without provider detail.
    if (outcome.kind === "failed" && outcome.stage === "before-model") {
      try {
        await send(chatId, "That message could not be answered. It is safe to try again.");
      } catch {
        // Delivery of the failure notice is best effort.
      }
    }
  }

  /** Voice note: download atomically under the cap, transcribe LOCALLY. */
  async function handleVoice(
    chatId: number,
    updateId: number,
    voice: { file_id: string; file_size?: number },
  ): Promise<void> {
    if (options.stt === undefined || options.attachmentDir === undefined) {
      await send(
        chatId,
        "Voice notes need a local transcriber, and none is configured. " +
          "Text works as always; a transcriber command can be configured in the settings.",
      );
      return;
    }
    const maxBytes = options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
    if (voice.file_size !== undefined && voice.file_size > maxBytes) {
      await send(chatId, "That voice note is larger than the configured limit and was not downloaded.");
      return;
    }

    const { value, redactor } = await token();
    let staged;
    try {
      const info = (await api("getFile", { file_id: voice.file_id })) as { file_path?: string };
      if (typeof info.file_path !== "string") {
        await send(chatId, "Telegram did not hand over that voice note.");
        return;
      }
      const response = await fetchImpl(`${apiOrigin}/file/bot${value}/${info.file_path}`, { method: "GET" });
      if (!response.ok || response.body === null) {
        await send(chatId, "Downloading the voice note failed. It is safe to send it again.");
        return;
      }
      staged = await stageAttachment({
        source: response.body as unknown as AsyncIterable<Uint8Array>,
        declaredName: info.file_path,
        directory: options.attachmentDir,
        maxBytes,
      });
    } catch (error) {
      const tooLarge = error instanceof AttachmentError && error.code === "too_large";
      await send(
        chatId,
        tooLarge
          ? "That voice note crossed the size limit mid-download and was discarded."
          : redactor.text("The voice note could not be stored. It is safe to send it again."),
      );
      return;
    }

    try {
      const transcript = await options.stt.transcribe(staged.path, { timeoutMs: 60_000 });
      if (!transcript.ok) {
        await send(chatId, transcript.text);
        return;
      }
      await runUserTurn(chatId, updateId, transcript.text);
    } finally {
      // The transcript enters the conversation; the audio bytes do not stay.
      await rm(staged.path, { force: true }).catch(() => undefined);
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined) return;
    if (message.chat.type !== "private") return; // groups ignored by default
    const from = message.from;
    if (from === undefined || from.is_bot) return; // never talk to bots
    if (!config.allowedUserIds.includes(from.id)) return; // deny by default

    if (message.photo !== undefined && message.photo.length > 0) {
      // Truthful unsupported-capability response: no configured provider
      // has EVIDENCED image input, so pretending would be a lie.
      await send(
        chatId(message),
        "Image input is not supported: no configured provider has evidenced image capability.",
      );
      return;
    }
    if (message.voice !== undefined) {
      await handleVoice(chatId(message), update.update_id, message.voice);
      return;
    }
    if (message.text === undefined) return;

    if (message.text.startsWith("/")) {
      await handleCommand(message.chat.id, message.text.trim().split(/\s/)[0] ?? "");
      return;
    }
    await runUserTurn(message.chat.id, update.update_id, message.text);
  }

  function chatId(message: { chat: { id: number } }): number {
    return message.chat.id;
  }

  async function pollOnce(): Promise<number> {
    const updates = (await api("getUpdates", {
      timeout: options.pollTimeoutSeconds ?? 25,
      ...(offset === undefined ? {} : { offset }),
    })) as TelegramUpdate[];

    for (const update of updates) {
      try {
        await handleUpdate(update);
      } catch {
        // One poisoned update must not kill the loop; the coordinator's
        // durable state already records what happened to the turn.
      }
      // The offset advances only after the update reached a durable point -
      // handleUpdate resolves after the coordinator persisted the turn - so a
      // crash before this line redelivers, and idempotency absorbs it.
      offset = update.update_id + 1;
    }
    return updates.length;
  }

  async function recoverDeliveries(): Promise<number> {
    // ONLY telegram turns: this coordinator's deliver callback speaks
    // sendMessage, and other surfaces' turns are not its to touch.
    const actions = await coordinator.recover("telegram");
    return actions.filter((a) => a.action === "redelivered").length;
  }

  return {
    status,
    probe,
    pollOnce,
    recoverDeliveries,
    sendText: (chatId: number, text: string) => send(chatId, text),
    async start(): Promise<TelegramStatus> {
      if (!config.enabled) {
        lastError = "Telegram is disabled in the configuration.";
        return status();
      }
      await probe();
      if (webhookConflict !== undefined || lastError !== undefined) return status();
      await recoverDeliveries();
      running = true;
      stopping = false;
      loop = (async () => {
        while (!stopping) {
          try {
            await pollOnce();
          } catch (error) {
            lastError = error instanceof Error ? error.message : "Polling failed.";
            // A getUpdates conflict (another poller) or transient failure:
            // back off and keep the daemon alive rather than crashing.
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        running = false;
      })();
      return status();
    },
    async stop(): Promise<void> {
      stopping = true;
      await loop?.catch(() => undefined);
      running = false;
    },
  };
}
