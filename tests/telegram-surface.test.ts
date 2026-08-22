/**
 * The Telegram surface against a FAKE loopback Bot API - no packet in these
 * tests ever leaves 127.0.0.1, and no real Telegram anything is involved.
 *
 * The fake speaks just enough Bot API to prove the gate: getMe,
 * getWebhookInfo, getUpdates with offset semantics, sendMessage with
 * scriptable failures. Every security default is proven by counting what the
 * fake ACTUALLY received.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { createSqliteTranscriptStore } from "../adapters/transcripts/sqlite-transcript-store.js";
import type { TranscriptStore } from "../core/ports/transcript-store.js";
import type { ModelProvider } from "../core/ports/model-provider.js";
import type { SecretStore } from "../core/ports/secret-store.js";
import {
  createTelegramSurface,
  splitForTelegram,
  TELEGRAM_MESSAGE_LIMIT,
  type TelegramConfig,
} from "../surfaces/telegram/telegram-surface.js";

// Assembled from fragments so no source line carries a token shape.
const TOKEN = ["1234567", "fake-bot-token-for-tests-only"].join(":");

interface FakeBotApi {
  origin: string;
  /** Updates the next getUpdates call will return (offset-filtered). */
  queue: unknown[];
  sent: { chat_id: number; text: string }[];
  methodCalls: string[];
  webhookUrl: string;
  /** How many sendMessage calls should fail before succeeding. */
  failSends: number;
  close(): Promise<void>;
}

async function fakeBotApi(): Promise<FakeBotApi> {
  const state = {
    queue: [] as unknown[],
    sent: [] as { chat_id: number; text: string }[],
    methodCalls: [] as string[],
    webhookUrl: "",
    failSends: 0,
    voiceBytes: Buffer.from("fake-ogg-bytes-for-tests"),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const answer = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      // Voice-note bytes travel on the file endpoint, not the method API.
      const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url);
      if (fileMatch !== null) {
        if (fileMatch[1] !== TOKEN) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(state.voiceBytes);
        return;
      }
      const match = /^\/bot([^/]+)\/(.+)$/.exec(url);
      if (match === null || match[1] !== TOKEN) {
        answer({ ok: false, description: "Unauthorized" });
        return;
      }
      const method = match[2] ?? "";
      state.methodCalls.push(method);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      switch (method) {
        case "getMe":
          answer({ ok: true, result: { id: 42, is_bot: true, username: "delos_test_bot" } });
          return;
        case "getFile":
          answer({ ok: true, result: { file_path: "voice/note-1.ogg" } });
          return;
        case "getWebhookInfo":
          answer({ ok: true, result: { url: state.webhookUrl } });
          return;
        case "getUpdates": {
          const offset = typeof body.offset === "number" ? body.offset : 0;
          const updates = state.queue.filter((u) => (u as { update_id: number }).update_id >= offset);
          if (updates.length === 0) {
            // A real long poll parks the request; approximate it so a running
            // poll loop does not spin hot against the fake.
            setTimeout(() => answer({ ok: true, result: [] }), 40);
            return;
          }
          answer({ ok: true, result: updates });
          return;
        }
        case "sendMessage":
          if (state.failSends > 0) {
            state.failSends--;
            answer({ ok: false, description: "Bad Gateway (scripted failure)" });
            return;
          }
          state.sent.push({ chat_id: body.chat_id, text: body.text });
          answer({ ok: true, result: { message_id: state.sent.length } });
          return;
        default:
          answer({ ok: false, description: `Unknown method ${method}` });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    get queue() {
      return state.queue;
    },
    set queue(v: unknown[]) {
      state.queue = v;
    },
    get sent() {
      return state.sent;
    },
    get methodCalls() {
      return state.methodCalls;
    },
    get webhookUrl() {
      return state.webhookUrl;
    },
    set webhookUrl(v: string) {
      state.webhookUrl = v;
    },
    get failSends() {
      return state.failSends;
    },
    set failSends(v: number) {
      state.failSends = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as FakeBotApi;
}

function secretStore(): SecretStore {
  return {
    name: "test-secrets",
    writable: false,
    has: async (id) => id === "telegram:bot",
    get: async (id) =>
      id === "telegram:bot"
        ? { found: true, value: TOKEN }
        : { found: false, reason: "not_configured", detail: "No secret is stored under that reference." },
  };
}

function harness(
  api: FakeBotApi,
  overrides: Partial<TelegramConfig> = {},
  store?: TranscriptStore,
  replyText?: string,
  extras: Partial<Parameters<typeof createTelegramSurface>[0]> = {},
) {
  let n = 0;
  const theStore =
    store ?? createSqliteTranscriptStore({ path: ":memory:", newId: (p) => `${p}-${++n}` });
  let calls = 0;
  const requests: { systemPrompt: string; messages: readonly { role: string; text: string }[] }[] = [];
  const provider: ModelProvider = {
    name: "fake",
    generate: async (request) => {
      calls++;
      requests.push({ systemPrompt: request.systemPrompt, messages: request.messages });
      return { ok: true, text: replyText ?? `Reply ${calls}.` };
    },
  };
  let t = 0;
  const config: TelegramConfig = {
    enabled: true,
    tokenSecretId: "telegram:bot",
    allowedUserIds: [1001],
    defaultProviderProfileId: "local",
    defaultPersonaId: "arti", // scan-allow-persona
    defaultVariants: [],
    ...overrides,
  };
  const surface = createTelegramSurface({
    config,
    secretStore: secretStore(),
    store: theStore,
    provider,
    buildRequest: async (conversationId, turnId, userText) => ({
      conversationId,
      turnId,
      systemPrompt: "You are the test persona.",
      messages: [{ role: "user", text: userText }],
    }),
    nowIso: () => `2026-08-01T12:00:${String(t++ % 60).padStart(2, "0")}.000Z`,
    apiOrigin: api.origin,
    pollTimeoutSeconds: 0,
    ...extras,
  });
  return { surface, store: theStore, modelCalls: () => calls, requests };
}

function dm(updateId: number, userId: number, text: string, chatType = "private", isBot = false) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: isBot },
      chat: { id: userId, type: chatType },
      text,
    },
  };
}

test("telegram: disabled by default configuration refuses to start", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api, { enabled: false });
    const status = await h.surface.start();
    assert.equal(status.running, false);
    assert.match(status.lastError ?? "", /disabled/);
    assert.equal(api.methodCalls.length, 0, "a disabled surface must not touch the network");
  } finally {
    await api.close();
  }
});

test("telegram: a registered webhook is a detected conflict, and is never deleted", async () => {
  const api = await fakeBotApi();
  try {
    api.webhookUrl = "https://example.invalid/hook";
    const h = harness(api);
    const status = await h.surface.start();
    assert.equal(status.running, false);
    assert.match(status.webhookConflict ?? "", /webhook/i);
    assert.ok(!api.methodCalls.includes("deleteWebhook"), "the webhook was deleted without the user");
    assert.ok(!api.methodCalls.includes("getUpdates"), "polling started despite the conflict");
  } finally {
    await api.close();
  }
});

test("telegram: allowlist, DM-only, and bot senders - the model never runs for them", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [
      dm(1, 9999, "not on the allowlist"),
      dm(2, 1001, "group message", "supergroup"),
      dm(3, 1001, "from a bot", "private", true),
      { update_id: 4 }, // no message at all
      dm(5, 1001, "the one legitimate message"),
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 1, "exactly one update was legitimate");
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0]?.chat_id, 1001);
    assert.equal(api.sent[0]?.text, "Reply 1.");
  } finally {
    await api.close();
  }
});

test("telegram: a redelivered update never runs the model or resends the reply", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [dm(10, 1001, "hello")];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 1);
    assert.equal(api.sent.length, 1);

    // Telegram redelivers the same update (at-least-once). Reset the offset
    // path by polling the same queue again through a FRESH surface sharing
    // the store - the durable external-turn identity is what must dedupe.
    const h2 = harness(api, {}, h.store);
    await h2.surface.pollOnce();
    assert.equal(h.modelCalls() + h2.modelCalls(), 1, "the model ran again for a duplicate update");
    assert.equal(api.sent.length, 1, "the reply was sent twice");
  } finally {
    await api.close();
  }
});

test("telegram: chat mapping persists across restart - same conversation continues", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [dm(20, 1001, "first")];
    await h.surface.pollOnce();

    const h2 = harness(api, {}, h.store);
    api.queue = [dm(21, 1001, "second")];
    await h2.surface.pollOnce();

    const conversations = await h.store.listConversations(false);
    const telegramConversations = conversations.filter((c) => c.surface === "telegram");
    assert.equal(telegramConversations.length, 1, "restart created a second conversation for the chat");
    const messages = await h.store.listMessages(telegramConversations[0]!.id);
    assert.equal(messages.length, 4, "user+assistant for both turns, in one conversation");
  } finally {
    await api.close();
  }
});

test("telegram: delivery failure is retried by recovery with zero model calls", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.failSends = 1; // the reply's sendMessage will fail once
    api.queue = [dm(30, 1001, "hello")];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 1);
    assert.equal(api.sent.length, 0, "the scripted failure did not fail");

    // Restart: a fresh surface over the same store recovers the delivery.
    const h2 = harness(api, {}, h.store);
    const redelivered = await h2.surface.recoverDeliveries();
    assert.equal(redelivered, 1);
    assert.equal(api.sent.length, 1, "the stored reply was not redelivered");
    assert.equal(api.sent[0]?.text, "Reply 1.");
    assert.equal(h2.modelCalls(), 0, "recovery must never call the model");
  } finally {
    await api.close();
  }
});

test("telegram: commands answer without calling the model", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [
      dm(40, 1001, "/start"),
      dm(41, 1001, "/status"),
      dm(42, 1001, "/persona"),
      dm(43, 1001, "/variants"),
      dm(44, 1001, "/new"),
      dm(45, 1001, "/unknown"),
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 0, "a command reached the model");
    assert.equal(api.sent.length, 6);
    assert.match(api.sent[2]?.text ?? "", /arti/); // scan-allow-persona
    assert.match(api.sent[4]?.text ?? "", /Archived/);
  } finally {
    await api.close();
  }
});

test("telegram: the token never appears in any status or error", async () => {
  const api = await fakeBotApi();
  await api.close(); // the API is unreachable: the worst error path
  const h = harness(api);
  const status = await h.surface.probe();
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(TOKEN), "the token leaked into a status");
  assert.ok(status.lastError !== undefined, "the unreachable API must surface an error");
});

test("telegram end to end through the daemon: config, start, real poll loop, reply", async () => {
  const api = await fakeBotApi();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { startDaemon } = await import("../surfaces/daemon/daemon.js");
  const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
  const dataDir = await mkdtemp(join(tmpdir(), "delos-tg-e2e-"));
  try {
    const daemon = await startDaemon({
      dataDir,
      shippedPersonaDir: shipped,
      env: { DELOS_TELEGRAM_BOT_TOKEN: TOKEN },
      // Providers are stubbed; the telegram surface itself uses PRODUCTION
      // fetch against the loopback fake Bot API.
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "served",
          choices: [{ message: { role: "assistant", content: "A reply from the model." } }],
        }),
      }),
      telegramApiOrigin: api.origin,
      seedProfiles: [
        {
          schemaVersion: 1,
          id: "local",
          kind: "openai-compatible",
          model: "local-model",
          baseUrl: "http://127.0.0.1:1/v1", // never dialled: provider fetch is stubbed
          auth: { transport: "none" },
        },
      ],
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${daemon.origin}${path}`, {
        method,
        headers: {
          "x-delos-session": daemon.sessionToken,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };

    const put = await call("PUT", "/api/v1/telegram/config", {
      enabled: true,
      tokenSecretId: "telegram:bot",
      tokenEnvVar: "DELOS_TELEGRAM_BOT_TOKEN",
      allowedUserIds: [1001],
      defaultProviderProfileId: "local",
      defaultPersonaId: "arti", // scan-allow-persona
      defaultVariants: [],
    });
    assert.equal(put.status, 200);

    api.queue = [dm(100, 1001, "Hello from Telegram.")];
    const started = await call("POST", "/api/v1/telegram/start");
    assert.equal(started.status, 200);
    assert.equal((started.json as { running?: boolean }).running, true);

    // The REAL poll loop picks the update up; wait for the delivered reply.
    for (let i = 0; i < 150 && api.sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(api.sent.length, 1, "the poll loop never delivered the reply");
    assert.equal(api.sent[0]?.chat_id, 1001);
    assert.equal(api.sent[0]?.text, "A reply from the model.");

    // The turn is in the canonical transcript, on a telegram conversation.
    const conversations = (await call("GET", "/api/v1/conversations")).json as {
      conversations: { id: string; surface: string }[];
    };
    const telegramConversation = conversations.conversations.find((c) => c.surface === "telegram");
    assert.ok(telegramConversation, "the chat mapping conversation exists");
    const messages = (await call("GET", `/api/v1/conversations/${telegramConversation!.id}/messages`))
      .json as { messages: { role: string; text: string }[] };
    assert.equal(messages.messages.length, 2);
    assert.equal(messages.messages[1]?.text, "A reply from the model.");

    const stopped = await call("POST", "/api/v1/telegram/stop");
    assert.equal(stopped.status, 200);
    await daemon.close();
  } finally {
    await api.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("telegram: long replies are split under the limit without losing content", () => {
  const line = "A line of reply text that repeats to exceed the message limit.";
  const text = Array.from({ length: 200 }, (_, i) => `${i}: ${line}`).join("\n");
  const parts = splitForTelegram(text);
  assert.ok(parts.length >= 2, "the text should have needed splitting");
  for (const part of parts) {
    assert.ok(part.length <= TELEGRAM_MESSAGE_LIMIT, "a part exceeds the Telegram limit");
  }
  // No content is lost: whitespace at split points may be trimmed, nothing else.
  const compact = (s: string) => s.replace(/\s+/g, "");
  assert.equal(parts.map(compact).join(""), compact(text));
  // A short text is untouched.
  assert.deepEqual(splitForTelegram("short"), ["short"]);
});

test("telegram: a voice note is downloaded atomically, transcribed locally, and answered", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createExternalCommandStt } = await import("../adapters/attachments/external-command-stt.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const fakeStt = join(here, "..", "..", "tests", "fixtures", "attachments", "fake-stt.mjs");
  const api = await fakeBotApi();
  const attachmentDir = await mkdtemp(join(tmpdir(), "delos-tg-voice-"));
  try {
    const h = harness(api, {}, undefined, undefined, {
      stt: createExternalCommandStt({ command: fakeStt, workDir: attachmentDir }),
      attachmentDir,
    });
    api.queue = [
      {
        update_id: 800,
        message: {
          message_id: 800,
          from: { id: 1001, is_bot: false },
          chat: { id: 1001, type: "private" },
          voice: { file_id: "voice-1", file_size: 24 },
        },
      },
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 1, "the transcript should have become a model turn");
    const lastRequest = h.requests[h.requests.length - 1];
    const userMessage = lastRequest?.messages[lastRequest.messages.length - 1];
    assert.match(userMessage?.text ?? "", /please water the plants tomorrow \(24 bytes\)/);
    assert.equal(api.sent.length, 1, "the reply went back to the chat");

    // The audio bytes do not stay: no staged file and no staging litter.
    const entries = await readdir(attachmentDir);
    assert.deepEqual(entries.filter((e) => e !== ".staging"), []);
  } finally {
    await api.close();
    await rm(attachmentDir, { recursive: true, force: true });
  }
});

test("telegram: without a transcriber, voice is truthfully unsupported - zero model calls", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [
      {
        update_id: 810,
        message: {
          message_id: 810,
          from: { id: 1001, is_bot: false },
          chat: { id: 1001, type: "private" },
          voice: { file_id: "voice-1", file_size: 24 },
        },
      },
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 0);
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0]?.text ?? "", /local transcriber.*none is configured/i);
    assert.ok(!api.methodCalls.includes("getFile"), "nothing was downloaded");
  } finally {
    await api.close();
  }
});

test("telegram: an oversized voice note is refused before download", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createExternalCommandStt } = await import("../adapters/attachments/external-command-stt.js");
  const here = dirname(fileURLToPath(import.meta.url));
  const fakeStt = join(here, "..", "..", "tests", "fixtures", "attachments", "fake-stt.mjs");
  const api = await fakeBotApi();
  const attachmentDir = await mkdtemp(join(tmpdir(), "delos-tg-voice-"));
  try {
    const h = harness(api, {}, undefined, undefined, {
      stt: createExternalCommandStt({ command: fakeStt, workDir: attachmentDir }),
      attachmentDir,
      maxAttachmentBytes: 1000,
    });
    api.queue = [
      {
        update_id: 820,
        message: {
          message_id: 820,
          from: { id: 1001, is_bot: false },
          chat: { id: 1001, type: "private" },
          voice: { file_id: "voice-1", file_size: 5000 },
        },
      },
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 0);
    assert.match(api.sent[0]?.text ?? "", /larger than the configured limit/);
    assert.ok(!api.methodCalls.includes("getFile"), "the pre-check must run before any download");
  } finally {
    await api.close();
    await rm(attachmentDir, { recursive: true, force: true });
  }
});

test("telegram: image input gets the truthful unsupported-capability response", async () => {
  const api = await fakeBotApi();
  try {
    const h = harness(api);
    api.queue = [
      {
        update_id: 830,
        message: {
          message_id: 830,
          from: { id: 1001, is_bot: false },
          chat: { id: 1001, type: "private" },
          photo: [{ file_id: "photo-1" }],
        },
      },
    ];
    await h.surface.pollOnce();
    assert.equal(h.modelCalls(), 0);
    assert.match(api.sent[0]?.text ?? "", /no configured provider has evidenced image capability/);
  } finally {
    await api.close();
  }
});

test("telegram: a long reply is delivered in segments but stored as ONE message", async () => {
  const api = await fakeBotApi();
  try {
    const longReply = "A sentence of the long reply. ".repeat(400).trim(); // ~12k chars
    const h = harness(api, {}, undefined, longReply);
    api.queue = [dm(700, 1001, "please answer at length")];
    await h.surface.pollOnce();
    assert.ok(api.sent.length >= 2, "the wire copy should have been segmented");
    for (const sent of api.sent) {
      assert.ok(sent.text.length <= TELEGRAM_MESSAGE_LIMIT);
    }
    const conversations = await h.store.listConversations(false);
    const conversation = conversations.find((c) => c.surface === "telegram");
    const messages = await h.store.listMessages(conversation!.id);
    const assistant = messages.filter((m) => m.role === "assistant");
    assert.equal(assistant.length, 1, "the canonical transcript must store one assistant message");
    assert.equal(assistant[0]?.text, longReply, "the stored text is the unsegmented original");
  } finally {
    await api.close();
  }
});

test("telegram: the hard cut never bisects a surrogate pair", () => {
  // Spaceless prose - the realistic CJK shape, represented here without CJK
  // literals - forcing the hard cut, with an emoji straddling the boundary.
  const text = "x".repeat(TELEGRAM_MESSAGE_LIMIT - 1) + "😀" + "y".repeat(200);
  const parts = splitForTelegram(text);
  assert.ok(parts.length >= 2);
  // Lone-surrogate detector (String.isWellFormed needs a newer lib target).
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const part of parts) {
    assert.ok(part.length <= TELEGRAM_MESSAGE_LIMIT);
    assert.ok(!loneSurrogate.test(part), "a split part carries a lone surrogate");
  }
  // Nothing lost and nothing reordered: the parts rejoin to the original
  // (no whitespace exists here for the trim at split points to touch).
  assert.equal(parts.join(""), text);
});
