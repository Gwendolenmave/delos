/**
 * Provider adapters, registry and connection test - synthetic tests.
 *
 * Every server is a stub fetch or a node:http loopback; no external host is
 * ever contacted, and every credential is assembled from fragments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProviderProfile } from "../core/domain/provider-profile.js";
import type { ModelRequest } from "../core/ports/model-provider.js";
import { createInMemorySecretStore } from "../adapters/secret-store/memory/in-memory-secret-store.js";
import { createEnvironmentSecretStore } from "../adapters/secret-store/environment/environment-secret-store.js";
import {
  createOpenAIResponsesProvider,
  createOpenAICompatibleProvider,
  OPENAI_OFFICIAL_BASE_URL,
  PROTOCOL_OPENAI_RESPONSES,
  PROTOCOL_OPENAI_CHAT_COMPLETIONS,
} from "../adapters/providers/openai/openai-adapters.js";
import {
  createAnthropicProvider,
  ANTHROPIC_OFFICIAL_BASE_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PROTOCOL_ANTHROPIC_MESSAGES,
} from "../adapters/providers/anthropic/anthropic-adapters.js";
import { createProviderRegistry } from "../adapters/providers/registry.js";
import { ProviderError, joinApiPath, type FetchLike, type HttpRequestInit } from "../adapters/providers/shared/http-provider-core.js";
import { testProviderConnection } from "../core/services/connection-test.js";
import { asModelProvider } from "../core/services/provider-bridge.js";

const KEY = "sk-" + "synthetic-adapter-key-000001";
const RELAY_KEY = "relay-" + "opaque-no-prefix-token";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(
  respond: (call: Captured) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url: string, init: HttpRequestInit) => {
    const captured: Captured = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    calls.push(captured);
    const { status, body } = await respond(captured);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    conversationId: "c-1",
    turnId: "t-1",
    systemPrompt: "You are a synthetic test persona.",
    messages: [
      { role: "user", text: "First question." },
      { role: "assistant", text: "First answer." },
      { role: "user", text: "Second question." },
    ],
    ...overrides,
  };
}

function responsesBody(text: string) {
  return {
    id: "resp-synthetic",
    model: "served-official",
    status: "completed",
    output: [
      { type: "reasoning", content: [] },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text },
          { type: "annotation-ignored" },
        ],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function chatBody(text: string) {
  return {
    id: "chat-synthetic",
    model: "served-compatible",
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  };
}

function anthropicBody(text: string) {
  return {
    id: "msg-synthetic",
    type: "message",
    model: "served-anthropic",
    content: [
      { type: "text", text },
      { type: "tool_use", name: "ignored" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 9, output_tokens: 4 },
  };
}

function officialOpenAIProfile() {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "official-openai",
    kind: "openai",
    model: "configured-model",
    auth: { transport: "bearer", secretId: "provider:openai" },
  });
}

function compatibleProfile(overrides: Record<string, unknown> = {}) {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "local-compatible",
    kind: "openai-compatible",
    model: "local-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: { transport: "none" },
    ...overrides,
  });
}

function officialAnthropicProfile() {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "official-anthropic",
    kind: "anthropic",
    model: "configured-anthropic-model",
    auth: { transport: "x-api-key", secretId: "provider:anthropic" },
  });
}

// --- OpenAI official (Responses) --------------------------------------------

test("openai official: request mapping, auth, extraction, metadata", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: responsesBody("A reply.") }));
  const provider = createOpenAIResponsesProvider({
    profile: officialOpenAIProfile(),
    credential: KEY,
    fetchImpl,
  });

  const turn = await provider.generate(request());
  assert.equal(turn.ok, true);
  if (!turn.ok) return;

  // wire facts
  const call = calls[0]!;
  assert.equal(call.url, `${OPENAI_OFFICIAL_BASE_URL}/responses`);
  assert.equal(call.headers["Authorization"], `Bearer ${KEY}`);
  assert.equal(call.body["model"], "configured-model");
  assert.equal(call.body["instructions"], "You are a synthetic test persona.", "system travels in instructions");
  assert.equal(call.body["store"], false, "no provider-side response retention is requested");
  assert.deepEqual(call.body["input"], [
    { role: "user", content: "First question." },
    { role: "assistant", content: "First answer." },
    { role: "user", content: "Second question." },
  ]);
  assert.ok(!("messages" in call.body), "responses protocol has no messages field");

  // result facts
  assert.equal(turn.result.text, "A reply.");
  assert.equal(turn.result.protocol, PROTOCOL_OPENAI_RESPONSES);
  assert.equal(turn.result.requestedModel, "configured-model");
  assert.equal(turn.result.servedModel, "served-official");
  assert.deepEqual(turn.result.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(turn.result.rawProviderMetadata?.["id"], "resp-synthetic");
  assert.ok(!JSON.stringify(turn).includes(KEY), "the credential leaked into the result");
});

test("openai official: authentication failure is safe and redacted", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 401,
    body: { error: { message: `bad key ${KEY}` } },
  }));
  const provider = createOpenAIResponsesProvider({
    profile: officialOpenAIProfile(),
    credential: KEY,
    fetchImpl,
  });
  const turn = await provider.generate(request());
  assert.equal(turn.ok, false);
  if (turn.ok) return;
  assert.equal(turn.error.code, "authentication-failed");
  assert.equal(turn.error.retryable, "no");
  assert.equal(turn.error.httpStatus, 401);
  assert.ok(!turn.error.message.includes(KEY));
});

test("openai official: a malformed body is malformed-response, not a crash", async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: { unexpected: true } }));
  const provider = createOpenAIResponsesProvider({
    profile: officialOpenAIProfile(),
    credential: KEY,
    fetchImpl,
  });
  const turn = await provider.generate(request());
  assert.equal(!turn.ok && turn.error.code, "malformed-response");
});

test("openai official: timeout maps to timeout with retryable yes", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "official-openai",
    kind: "openai",
    model: "m",
    auth: { transport: "bearer", secretId: "provider:openai" },
    timeoutMs: 1000,
  });
  const started = Date.now();
  const provider = createOpenAIResponsesProvider({ profile, credential: KEY, fetchImpl });
  const turn = await provider.generate(request());
  assert.ok(Date.now() - started < 10_000);
  assert.equal(!turn.ok && turn.error.code, "timeout");
  if (!turn.ok) assert.equal(turn.error.retryable, "yes");
});

test("openai official: caller cancellation maps to cancelled, not timeout", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const controller = new AbortController();
  const provider = createOpenAIResponsesProvider({
    profile: officialOpenAIProfile(),
    credential: KEY,
    fetchImpl,
  });
  const pending = provider.generate(request(), { signal: controller.signal });
  controller.abort();
  const turn = await pending;
  assert.equal(!turn.ok && turn.error.code, "cancelled");
});

// --- OpenAI-compatible (chat completions) -----------------------------------

test("compatible: custom root, no auth, chat-completions mapping", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: chatBody("Local reply.") }));
  const provider = createOpenAICompatibleProvider({ profile: compatibleProfile(), fetchImpl });

  const turn = await provider.generate(request());
  assert.equal(turn.ok, true);
  if (!turn.ok) return;

  const call = calls[0]!;
  assert.equal(call.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(call.headers["Authorization"], undefined, "no auth header in no-auth mode");
  const messages = call.body["messages"] as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system", "chat protocol carries system as a message");
  assert.equal(turn.result.protocol, PROTOCOL_OPENAI_CHAT_COMPLETIONS);
  assert.equal(turn.result.servedModel, "served-compatible");
  assert.deepEqual(turn.result.usage, { inputTokens: 5, outputTokens: 3 });
});

test("compatible: trailing slashes never duplicate the path", () => {
  assert.equal(joinApiPath("http://127.0.0.1:1234/v1///", "/chat/completions"),
    "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(joinApiPath("http://127.0.0.1:1234", "/chat/completions"),
    "http://127.0.0.1:1234/chat/completions");
});

test("compatible: bearer auth with an opaque, prefix-free token", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: chatBody("ok") }));
  const profile = compatibleProfile({
    auth: { transport: "bearer", secretId: "provider:relay" },
  });
  const provider = createOpenAICompatibleProvider({ profile, credential: RELAY_KEY, fetchImpl });
  await provider.generate(request());
  assert.equal(calls[0]!.headers["Authorization"], `Bearer ${RELAY_KEY}`,
    "an sk- prefix is not required and not checked");
});

test("compatible: custom header auth places the credential under that name only", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: chatBody("ok") }));
  const profile = compatibleProfile({
    auth: { transport: "custom-header", secretId: "provider:relay", headerName: "X-Gateway-Auth" },
  });
  const provider = createOpenAICompatibleProvider({ profile, credential: RELAY_KEY, fetchImpl });
  await provider.generate(request());
  assert.equal(calls[0]!.headers["X-Gateway-Auth"], RELAY_KEY);
  assert.equal(calls[0]!.headers["Authorization"], undefined);
});

test("compatible: extra non-secret headers survive; served-model mismatch is reported not repaired", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: chatBody("ok") }));
  const profile = compatibleProfile({ headers: { "X-Gateway-Region": "local" } });
  const provider = createOpenAICompatibleProvider({ profile, fetchImpl });
  const turn = await provider.generate(request());
  assert.equal(calls[0]!.headers["X-Gateway-Region"], "local");
  if (turn.ok) {
    assert.equal(turn.result.requestedModel, "local-model");
    assert.equal(turn.result.servedModel, "served-compatible", "mismatch stays visible");
  }
});

test("compatible: a response without usage or model keeps those fields unknown", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 200,
    body: { choices: [{ message: { content: "bare" } }] },
  }));
  const provider = createOpenAICompatibleProvider({ profile: compatibleProfile(), fetchImpl });
  const turn = await provider.generate(request());
  assert.equal(turn.ok, true);
  if (turn.ok) {
    assert.equal(turn.result.servedModel, undefined, "unknown stays unknown");
    assert.equal(turn.result.usage, undefined);
  }
});

test("compatible: a profile without baseUrl is refused at construction", () => {
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "official-openai",
    kind: "openai",
    model: "m",
    auth: { transport: "bearer", secretId: "provider:openai" },
  });
  // Hand an official profile (no baseUrl) to the compatible factory directly.
  assert.throws(
    () => createOpenAICompatibleProvider({ profile, credential: KEY }),
    (error: unknown) => error instanceof ProviderError && error.code === "profile-invalid",
  );
});

// --- Anthropic (official and compatible) ------------------------------------

test("anthropic official: system separation, headers, extraction, usage", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: anthropicBody("Claude-shaped reply.") }));
  const provider = createAnthropicProvider({
    profile: officialAnthropicProfile(),
    credential: KEY,
    fetchImpl,
  });

  const turn = await provider.generate(request());
  assert.equal(turn.ok, true);
  if (!turn.ok) return;

  const call = calls[0]!;
  assert.equal(call.url, `${ANTHROPIC_OFFICIAL_BASE_URL}/v1/messages`);
  assert.equal(call.headers["x-api-key"], KEY, "official Anthropic auth is x-api-key, not bearer");
  assert.equal(call.headers["Authorization"], undefined);
  assert.equal(call.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(call.body["system"], "You are a synthetic test persona.", "system is a top-level field");
  assert.equal(call.body["max_tokens"], DEFAULT_MAX_OUTPUT_TOKENS, "the protocol requires max_tokens");
  const messages = call.body["messages"] as Array<{ role: string }>;
  assert.ok(messages.every((m) => m.role === "user" || m.role === "assistant"),
    "no system role exists in this protocol");

  assert.equal(turn.result.text, "Claude-shaped reply.");
  assert.equal(turn.result.protocol, PROTOCOL_ANTHROPIC_MESSAGES);
  assert.equal(turn.result.servedModel, "served-anthropic");
  assert.deepEqual(turn.result.usage, { inputTokens: 9, outputTokens: 4 });
  assert.equal(turn.result.rawProviderMetadata?.["stop_reason"], "end_turn");
});

test("anthropic: multiple text blocks concatenate; non-text blocks are ignored", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 200,
    body: {
      content: [
        { type: "text", text: "Part one. " },
        { type: "thinking", thinking: "MUST-NOT-SURFACE" },
        { type: "text", text: "Part two." },
      ],
    },
  }));
  const provider = createAnthropicProvider({ profile: officialAnthropicProfile(), credential: KEY, fetchImpl });
  const turn = await provider.generate(request());
  assert.equal(turn.ok && turn.result.text, "Part one. Part two.");
  assert.ok(!JSON.stringify(turn).includes("MUST-NOT-SURFACE"), "a thinking block leaked");
});

test("anthropic: authentication error, timeout and malformed body normalise safely", async () => {
  const authFail = createAnthropicProvider({
    profile: officialAnthropicProfile(),
    credential: KEY,
    fetchImpl: stubFetch(() => ({ status: 401, body: { error: { message: `key ${KEY}` } } })).fetchImpl,
  });
  const t1 = await authFail.generate(request());
  assert.equal(!t1.ok && t1.error.code, "authentication-failed");
  if (!t1.ok) assert.ok(!t1.error.message.includes(KEY));

  const malformed = createAnthropicProvider({
    profile: officialAnthropicProfile(),
    credential: KEY,
    fetchImpl: stubFetch(() => ({ status: 200, body: { content: "not-an-array" } })).fetchImpl,
  });
  const t2 = await malformed.generate(request());
  assert.equal(!t2.ok && t2.error.code, "malformed-response");
});

test("anthropic-compatible: custom base, bearer transport, gateway headers", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: anthropicBody("via gateway") }));
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "gateway",
    kind: "anthropic-compatible",
    model: "m",
    baseUrl: "http://127.0.0.1:8787/anthropic/",
    auth: { transport: "bearer", secretId: "provider:gateway" },
    headers: { "X-Gateway-Tenant": "local" },
  });
  const provider = createAnthropicProvider({ profile, credential: RELAY_KEY, fetchImpl });
  const turn = await provider.generate(request());
  assert.equal(turn.ok, true);
  const call = calls[0]!;
  assert.equal(call.url, "http://127.0.0.1:8787/anthropic/v1/messages");
  assert.equal(call.headers["Authorization"], `Bearer ${RELAY_KEY}`);
  assert.equal(call.headers["X-Gateway-Tenant"], "local");
  assert.equal(call.headers["anthropic-version"], ANTHROPIC_VERSION, "the managed header survives a gateway");
});

test("anthropic: a profile supplying anthropic-version is refused as a conflict", () => {
  const profile = parseProviderProfile({
    schemaVersion: 1,
    id: "gateway",
    kind: "anthropic-compatible",
    model: "m",
    baseUrl: "http://127.0.0.1:8787",
    auth: { transport: "none" },
    headers: { "anthropic-version": "1999-01-01" },
  });
  assert.throws(
    () => createAnthropicProvider({ profile }),
    (error: unknown) => error instanceof ProviderError && error.code === "profile-invalid",
  );
});

// --- registry and connection test -------------------------------------------

test("registry: resolves each kind to its protocol, secrets through the store", async () => {
  const { fetchImpl, calls } = stubFetch((call) =>
    call.url.includes("/v1/messages")
      ? { status: 200, body: anthropicBody("anthropic ok") }
      : call.url.includes("/responses")
        ? { status: 200, body: responsesBody("openai ok") }
        : { status: 200, body: chatBody("compat ok") },
  );
  const secretStore = createInMemorySecretStore({
    initial: { "provider:openai": KEY, "provider:anthropic": RELAY_KEY },
  });
  const registry = createProviderRegistry({ secretStore, fetchImpl });

  const official = registry.createFromProfile(officialOpenAIProfile());
  const anthropic = registry.createFromProfile(officialAnthropicProfile());
  const compat = registry.createFromProfile(compatibleProfile());

  const [a, b, c] = await Promise.all([
    official.generate(request()),
    anthropic.generate(request()),
    compat.generate(request()),
  ]);
  assert.equal(a.ok && a.result.protocol, PROTOCOL_OPENAI_RESPONSES);
  assert.equal(b.ok && b.result.protocol, PROTOCOL_ANTHROPIC_MESSAGES);
  assert.equal(c.ok && c.result.protocol, PROTOCOL_OPENAI_CHAT_COMPLETIONS);

  // isolation: each call carried its own credential and only its own
  const openaiCall = calls.find((x) => x.url.includes("/responses"))!;
  const anthropicCall = calls.find((x) => x.url.includes("/v1/messages"))!;
  const compatCall = calls.find((x) => x.url.includes("11434"))!;
  assert.equal(openaiCall.headers["Authorization"], `Bearer ${KEY}`);
  assert.equal(openaiCall.headers["x-api-key"], undefined);
  assert.equal(anthropicCall.headers["x-api-key"], RELAY_KEY);
  assert.equal(anthropicCall.headers["Authorization"], undefined);
  assert.equal(compatCall.headers["Authorization"], undefined);
  assert.equal(compatCall.headers["x-api-key"], undefined);
});

test("registry: a missing credential is credential-missing, not connection-failed", async () => {
  const registry = createProviderRegistry({
    secretStore: createInMemorySecretStore(),
    fetchImpl: stubFetch(() => ({ status: 200, body: chatBody("unreachable") })).fetchImpl,
  });
  const provider = registry.createFromProfile(officialOpenAIProfile());
  const turn = await provider.generate(request());
  assert.equal(!turn.ok && turn.error.code, "credential-missing");
  if (!turn.ok) assert.equal(turn.error.retryable, "no");
});

test("registry: an empty environment variable is credential-unavailable", async () => {
  const registry = createProviderRegistry({
    secretStore: createEnvironmentSecretStore({
      env: { OPENAI_API_KEY: "" },
      mapping: { "provider:openai": "OPENAI_API_KEY" },
    }),
    fetchImpl: stubFetch(() => ({ status: 200, body: chatBody("x") })).fetchImpl,
  });
  const provider = registry.createFromProfile(officialOpenAIProfile());
  const turn = await provider.generate(request());
  assert.equal(!turn.ok && turn.error.code, "credential-unavailable");
});

test("registry: a credential set after a failure works without rebuilding", async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: responsesBody("now works") }));
  const store = createInMemorySecretStore();
  const registry = createProviderRegistry({ secretStore: store, fetchImpl });
  const provider = registry.createFromProfile(officialOpenAIProfile());

  const before = await provider.generate(request());
  assert.equal(!before.ok && before.error.code, "credential-missing");

  await store.set?.("provider:openai", KEY);
  const after = await provider.generate(request());
  assert.equal(after.ok, true, "per-call resolution picks up the new credential");
});

test("registry: an unsupported kind and an invalid document are profile-invalid", () => {
  const registry = createProviderRegistry({ secretStore: createInMemorySecretStore() });
  assert.throws(
    () => registry.create({ schemaVersion: 1, id: "x", kind: "mystery", model: "m", auth: { transport: "none" } }),
    (error: unknown) => error instanceof ProviderError && error.code === "profile-invalid",
  );
  assert.throws(
    () => registry.create("not an object"),
    (error: unknown) => error instanceof ProviderError && error.code === "profile-invalid",
  );
});

test("connection test: success reports evidence, and the probe text goes nowhere", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: chatBody("probe reply MUST-NOT-SURFACE") }));
  const registry = createProviderRegistry({ secretStore: createInMemorySecretStore(), fetchImpl });
  const provider = registry.createFromProfile(compatibleProfile());

  let t = 1000;
  const report = await testProviderConnection(provider, { now: () => (t += 25) });
  assert.equal(report.ok, true);
  if (report.ok) {
    assert.equal(report.requestedModel, "local-model");
    assert.equal(report.servedModel, "served-compatible");
    assert.equal(report.latencyMs, 25);
    assert.equal(report.protocol, PROTOCOL_OPENAI_CHAT_COMPLETIONS);
  }
  assert.ok(!JSON.stringify(report).includes("MUST-NOT-SURFACE"), "the probe reply leaked into the report");
  assert.equal(calls.length, 1);
});

test("connection test: failure carries the safe error contract", async () => {
  const registry = createProviderRegistry({
    secretStore: createInMemorySecretStore(),
    fetchImpl: stubFetch(() => ({ status: 500, body: {} })).fetchImpl,
  });
  const provider = registry.createFromProfile(compatibleProfile());
  const report = await testProviderConnection(provider);
  assert.equal(report.ok, false);
  if (!report.ok) {
    assert.equal(report.error.code, "provider-error");
    assert.equal(report.error.retryable, "yes");
    assert.equal(report.error.httpStatus, 500);
  }
});

// --- the bridge --------------------------------------------------------------

test("the bridge maps rich failures onto legacy kinds the turn service knows", async () => {
  const registry = createProviderRegistry({
    secretStore: createInMemorySecretStore(),
    fetchImpl: stubFetch(() => ({ status: 429, body: {} })).fetchImpl,
  });
  const legacy = asModelProvider(registry.createFromProfile(compatibleProfile()));
  const result = await legacy.generate(request());
  assert.equal(!result.ok && result.errorKind, "rate_limit");

  const missing = asModelProvider(
    createProviderRegistry({ secretStore: createInMemorySecretStore() })
      .createFromProfile(officialOpenAIProfile()),
  );
  const r2 = await missing.generate(request());
  assert.equal(!r2.ok && r2.errorKind, "configuration");
});

test("the bridge passes success through with served-model metadata", async () => {
  const registry = createProviderRegistry({
    secretStore: createInMemorySecretStore(),
    fetchImpl: stubFetch(() => ({ status: 200, body: chatBody("bridged") })).fetchImpl,
  });
  const legacy = asModelProvider(registry.createFromProfile(compatibleProfile()));
  const result = await legacy.generate(request());
  assert.equal(result.ok && result.text, "bridged");
  if (result.ok) assert.equal(result.servedModel, "served-compatible");
});

// --- redirect containment (unit level; end-to-end lives in the CLI suite) ---

test("every redirect status is rejected as a safe protocol error", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { fetchImpl } = stubFetch(() => ({ status, body: {} }));
    const provider = createOpenAICompatibleProvider({ profile: compatibleProfile(), fetchImpl });
    const turn = await provider.generate(request());
    assert.equal(turn.ok, false, `status ${status} was accepted`);
    if (!turn.ok) {
      assert.equal(turn.error.code, "protocol-error");
      assert.equal(turn.error.retryable, "no");
      assert.equal(turn.error.httpStatus, status);
      assert.ok(!turn.error.message.includes("Location"), "redirect detail surfaced");
    }
  }
});
