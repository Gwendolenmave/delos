import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

import {
  createOpenAICompatibleProvider,
  type FetchLike as LegacyFetchLike,
} from "../adapters/models/openai-compatible/openai-compatible-provider.js";
import {
  postJson,
  ProviderError,
  type FetchLike,
} from "../adapters/providers/shared/http-provider-core.js";
import { createRedactor } from "../core/services/redaction.js";
import type { ModelRequest } from "../core/ports/model-provider.js";

const REQUEST: ModelRequest = {
  conversationId: "conv-reliability-synthetic",
  turnId: "turn-reliability-synthetic",
  systemPrompt: "Synthetic provider reliability fixture.",
  messages: [{ role: "user", text: "Synthetic request." }],
};

const okBody = { model: "served-synthetic", choices: [{ message: { content: "ok" } }] };
const never = <T>() => new Promise<T>(() => {});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("schemaVersion 1 transport refuses a real redirect instead of replaying the request", async () => {
  let originCalls = 0;
  let targetCalls = 0;

  const target = createServer((_request, response) => {
    targetCalls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(okBody));
  });
  const targetOrigin = await listen(target);

  const origin = createServer((_request, response) => {
    originCalls++;
    response.writeHead(307, { Location: `${targetOrigin}/v1/chat/completions` });
    response.end();
  });
  const originUrl = await listen(origin);

  const credential = "token-" + "synthetic-v1-redirect-fixture";
  try {
    const result = await createOpenAICompatibleProvider({
      baseUrl: `${originUrl}/v1`,
      model: "synthetic-model",
      apiKey: credential,
      timeoutMs: 2_000,
    }).generate(REQUEST);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "provider_error");
      assert.match(result.detail, /redirect/i);
      assert.ok(!result.detail.includes(targetOrigin));
      assert.ok(!result.detail.includes(credential));
    }
    assert.equal(originCalls, 1);
    assert.equal(targetCalls, 0, "credential-bearing POST followed the redirect");
  } finally {
    await close(origin);
    await close(target);
  }
});

test("schemaVersion 1 hard deadline returns even when custom transport never settles", async () => {
  const fetchImpl: LegacyFetchLike = async () => never();
  const started = Date.now();

  const result = await createOpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "synthetic-model",
    timeoutMs: 20,
    fetchImpl,
  }).generate(REQUEST);

  assert.ok(Date.now() - started < 2_000, "legacy provider did not return at its deadline");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorKind, "timeout");
});

test("schemaVersion 1 hard deadline also bounds a body reader that never settles", async () => {
  const fetchImpl: LegacyFetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => never(),
  });
  const started = Date.now();

  const result = await createOpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "synthetic-model",
    timeoutMs: 20,
    fetchImpl,
  }).generate(REQUEST);

  assert.ok(Date.now() - started < 2_000, "legacy body read outlived its deadline");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorKind, "timeout");
});

function exchange(fetchImpl: FetchLike, extra: { signal?: AbortSignal } = {}) {
  return postJson({
    url: "https://example.invalid/v1/test",
    body: { input: "synthetic" },
    headers: { "content-type": "application/json" },
    timeoutMs: 20,
    providerKind: "synthetic-provider",
    fetchImpl,
    redactor: createRedactor(),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  });
}

function isProviderError(error: unknown, code: string): boolean {
  return error instanceof ProviderError && error.code === code;
}

test("profile HTTP hard deadline returns when FetchLike never settles", async () => {
  const fetchImpl: FetchLike = async () => never();
  const started = Date.now();

  await assert.rejects(exchange(fetchImpl), (error: unknown) => isProviderError(error, "timeout"));
  assert.ok(Date.now() - started < 2_000, "profile transport did not return at its deadline");
});

test("profile HTTP hard deadline bounds a body reader that never settles", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => never(),
  });
  const started = Date.now();

  await assert.rejects(exchange(fetchImpl), (error: unknown) => isProviderError(error, "timeout"));
  assert.ok(Date.now() - started < 2_000, "profile body read outlived its deadline");
});

test("caller cancellation returns even when FetchLike never settles", async () => {
  const caller = new AbortController();
  const fetchImpl: FetchLike = async () => never();

  const pending = postJson({
    url: "https://example.invalid/v1/test",
    body: { input: "synthetic" },
    headers: { "content-type": "application/json" },
    timeoutMs: 2_000,
    providerKind: "synthetic-provider",
    fetchImpl,
    redactor: createRedactor(),
    signal: caller.signal,
  });
  setTimeout(() => caller.abort(), 20);

  await assert.rejects(pending, (error: unknown) => isProviderError(error, "cancelled"));
});

test("an already-cancelled profile request never invokes FetchLike", async () => {
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await assert.rejects(
    postJson({
      url: "https://example.invalid/v1/test",
      body: { input: "synthetic" },
      headers: { "content-type": "application/json" },
      timeoutMs: 2_000,
      providerKind: "synthetic-provider",
      fetchImpl,
      redactor: createRedactor(),
      signal: caller.signal,
    }),
    (error: unknown) => isProviderError(error, "cancelled"),
  );
  assert.equal(calls, 0);
});
