/**
 * openai-compatible-provider - synthetic tests.
 *
 * `fetch` is always injected. No test reaches a network, and no value here
 * resembles a real credential or a real conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAICompatibleProvider,
  buildChatCompletionsUrl,
  PROVIDER_NAME,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
} from "../adapters/models/openai-compatible/openai-compatible-provider.js";
import type { ModelRequest } from "../core/ports/model-provider.js";
import type { ChatMessage } from "../core/domain/types.js";

/** Assembled from fragments so this file holds no credential-shaped literal. */
const TEST_KEY = "sk-" + "synthetic-test-key-value";

const BASE = "http://127.0.0.1:11434/v1";

interface Captured {
  url: string;
  init: HttpRequestInit;
  payload: Record<string, unknown>;
}

function okBody(text: string, model = "served-model-1"): unknown {
  return { model, choices: [{ message: { role: "assistant", content: text } }] };
}

function stubFetch(
  respond: (call: Captured) => HttpResponseLike | Promise<HttpResponseLike>,
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const captured: Captured = {
      url,
      init,
      payload: JSON.parse(init.body) as Record<string, unknown>,
    };
    calls.push(captured);
    return respond(captured);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const HISTORY: readonly ChatMessage[] = [
  { role: "user", text: "First question." },
  { role: "assistant", text: "First answer." },
];

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    conversationId: "conv-synthetic-1",
    turnId: "turn-synthetic-1",
    systemPrompt: "You are a test assistant.",
    messages: [...HISTORY, { role: "user", text: "Second question." }],
    ...overrides,
  };
}

function provider(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  return createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: "configured-model",
    timeoutMs: 5_000,
    fetchImpl,
    ...extra,
  });
}

// --- URL construction ------------------------------------------------------

test("every trailing slash is normalised away, not just one", () => {
  // A doubled slash is a different path to some servers, and a user who typed
  // one extra character meant the same root.
  for (const root of [
    "http://127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1/",
    "http://127.0.0.1:11434/v1//",
    "http://127.0.0.1:11434/v1///",
  ]) {
    assert.equal(
      buildChatCompletionsUrl(root),
      "http://127.0.0.1:11434/v1/chat/completions",
      `root: ${root}`,
    );
  }
});

test("a root host with no path joins without a doubled slash", () => {
  for (const root of [
    "https://example.invalid",
    "https://example.invalid/",
    "https://example.invalid///",
  ]) {
    assert.equal(
      buildChatCompletionsUrl(root),
      "https://example.invalid/chat/completions",
      `root: ${root}`,
    );
  }
});

test("a missing version segment is not invented", () => {
  // Guessing "/v1" would make the configured value mean something the user
  // did not write.
  assert.equal(
    buildChatCompletionsUrl("https://example.invalid"),
    "https://example.invalid/chat/completions",
  );
});

test("the joined URL is what the adapter actually requests", async () => {
  // The unit above proves the string; this proves the string is the one used.
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl, { baseUrl: "http://127.0.0.1:11434/v1///" }).generate(
    makeRequest(),
  );
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/v1/chat/completions");
});

// --- request mapping -------------------------------------------------------

test("the configured model is sent when the request does not override it", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  assert.equal(calls[0]?.payload["model"], "configured-model");
});

test("a per-request model overrides the configured one", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest({ model: "override-model" }));
  assert.equal(calls[0]?.payload["model"], "override-model");
});

test("a null request model falls back to the configured model", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest({ model: null }));
  assert.equal(calls[0]?.payload["model"], "configured-model");
});

test("the system prompt leads and dialogue follows in order", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());

  assert.deepEqual(calls[0]?.payload["messages"], [
    { role: "system", content: "You are a test assistant." },
    { role: "user", content: "First question." },
    { role: "assistant", content: "First answer." },
    { role: "user", content: "Second question." },
  ]);
});

test("the current user message remains last", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  const messages = calls[0]?.payload["messages"] as WireLike[];
  const last = messages[messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.content, "Second question.");
});

interface WireLike {
  role: string;
  content: string;
}

test("streaming is explicitly disabled", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  assert.equal(calls[0]?.payload["stream"], false);
});

test("no sampling, tool or format parameters are invented", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  assert.deepEqual(Object.keys(calls[0]?.payload ?? {}).sort(), [
    "messages",
    "model",
    "stream",
  ]);
});

test("conversation and turn identifiers do not leak into the payload", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  const serialised = calls[0]?.init.body ?? "";
  assert.ok(!serialised.includes("conv-synthetic-1"));
  assert.ok(!serialised.includes("turn-synthetic-1"));
});

test("Unicode and multiline content survive unchanged", async () => {
  const text = "Line one\n\tindented\n\n" + String.fromCodePoint(0x1f600) + " end";
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(
    makeRequest({ messages: [{ role: "user", text }] }),
  );
  const messages = calls[0]?.payload["messages"] as WireLike[];
  assert.equal(messages[1]?.content, text);
});

test("the request message array and its objects are not mutated", async () => {
  const messages: ChatMessage[] = [
    { role: "user", text: "one" },
    { role: "user", text: "two" },
  ];
  const before = messages.map((m) => ({ ...m }));
  const { fetchImpl } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest({ messages }));
  assert.deepEqual(messages, before);
});

// --- headers and credentials -----------------------------------------------

test("an authorization header is sent only when a key is supplied", async () => {
  const withKey = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(withKey.fetchImpl, { apiKey: TEST_KEY }).generate(makeRequest());
  assert.equal(withKey.calls[0]?.init.headers["Authorization"], `Bearer ${TEST_KEY}`);

  const noKey = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(noKey.fetchImpl).generate(makeRequest());
  assert.equal(noKey.calls[0]?.init.headers["Authorization"], undefined);
});

test("content type is always declared", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl).generate(makeRequest());
  assert.equal(calls[0]?.init.headers["Content-Type"], "application/json");
});

test("no telemetry or account-identifying headers are invented", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  await provider(fetchImpl, { apiKey: TEST_KEY }).generate(makeRequest());
  assert.deepEqual(
    Object.keys(calls[0]?.init.headers ?? {}).sort(),
    ["Authorization", "Content-Type"],
  );
});

test("the credential never appears in any failure detail", async () => {
  const failures: FetchLike[] = [
    async () => jsonResponse(401, {}),
    async () => jsonResponse(429, {}),
    async () => jsonResponse(500, {}),
    async () => {
      throw new Error(`connect ECONNREFUSED using ${TEST_KEY}`);
    },
    async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  ];
  for (const fetchImpl of failures) {
    const result = await provider(fetchImpl, { apiKey: TEST_KEY }).generate(
      makeRequest(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.detail.includes(TEST_KEY), "the credential leaked");
    }
  }
});

// --- failure mapping -------------------------------------------------------

test("an unusable adapter configuration is reported, not thrown", async () => {
  for (const [label, overrides] of [
    ["empty base url", { baseUrl: "" }],
    ["empty model", { model: "  " }],
    ["non-positive timeout", { timeoutMs: 0 }],
  ] as const) {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
    const result = await createOpenAICompatibleProvider({
      ...{ baseUrl: BASE, model: "m", timeoutMs: 5_000 },
      ...overrides,
      fetchImpl,
    }).generate(makeRequest());

    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.errorKind, "configuration", label);
    assert.equal(calls.length, 0, `${label}: should not have called fetch`);
  }
});

test("HTTP status codes map to conservative error kinds", async () => {
  const cases: Array<[number, string]> = [
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate_limit"],
    [400, "provider_error"],
    [404, "provider_error"],
    [500, "provider_error"],
    [503, "provider_error"],
  ];
  for (const [status, kind] of cases) {
    const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: "x" }));
    const result = await provider(fetchImpl).generate(makeRequest());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, kind, `HTTP ${status}`);
      assert.ok(result.detail.includes(String(status)));
    }
  }
});

test("a transport failure is reported as network, not as a timeout", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorKind, "network");
});

test("the configured deadline maps to a timeout", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const result = await createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: "m",
    timeoutMs: 20,
    fetchImpl,
  }).generate(makeRequest());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, "timeout");
    assert.ok(result.detail.includes("20"));
  }
});

// --- the deadline covers the whole exchange --------------------------------
//
// Aborting once headers arrive protects the least likely part of a response to
// stall. A provider that answers `200` immediately and then stops sending
// would hold the caller forever, which is the failure a deadline exists to
// prevent.

test("a provider that sends headers and then stops is a timeout", async () => {
  let bodyReadReached = false;
  const fetchImpl: FetchLike = async (_url, init) => ({
    ok: true,
    status: 200,
    // Headers arrive at once. The body never does.
    json: () =>
      new Promise<unknown>((_resolve, reject) => {
        bodyReadReached = true;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });

  const started = Date.now();
  const result = await createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: "m",
    timeoutMs: 40,
    fetchImpl,
  }).generate(makeRequest());
  const elapsed = Date.now() - started;

  assert.ok(bodyReadReached, "the body read was never reached");
  assert.ok(elapsed < 5_000, `generate did not return for ${elapsed} ms`);
  assert.equal(result.ok, false);
  if (!result.ok) {
    // Not invalid_response: the body was not malformed, the budget ran out.
    assert.equal(result.errorKind, "timeout");
    assert.ok(result.detail.includes("40"));
  }
});

test("a malformed body and a stalled body are told apart", async () => {
  const shared = { baseUrl: BASE, model: "m", timeoutMs: 40 };

  const malformed = await createOpenAICompatibleProvider({
    ...shared,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    }),
  }).generate(makeRequest());

  const stalled = await createOpenAICompatibleProvider({
    ...shared,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise<unknown>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
  }).generate(makeRequest());

  assert.equal(malformed.ok, false);
  assert.equal(stalled.ok, false);
  if (!malformed.ok && !stalled.ok) {
    assert.equal(malformed.errorKind, "invalid_response");
    assert.equal(stalled.errorKind, "timeout");
  }
});

test("the deadline timer is cleared once a reply has been read", async () => {
  const timeoutMs = 25;
  let signal: AbortSignal | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    signal = init.signal;
    return jsonResponse(200, okBody("done"));
  };

  const result = await createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: "m",
    timeoutMs,
    fetchImpl,
  }).generate(makeRequest());
  assert.equal(result.ok, true);

  // Well past the deadline. A timer left armed would have aborted by now, and
  // would also have kept the process alive after the work was done.
  await new Promise((resolveWait) => setTimeout(resolveWait, timeoutMs * 8));
  assert.ok(signal);
  assert.equal(signal.aborted, false, "the deadline outlived the request");
});

test("a body that is slow but arrives inside the deadline still succeeds", async () => {
  // The deadline covering the body must not truncate a merely slow provider.
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise<unknown>((resolveBody) => {
        setTimeout(() => resolveBody(okBody("a slow but complete reply")), 20);
      }),
  });
  const result = await createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: "m",
    timeoutMs: 2_000,
    fetchImpl,
  }).generate(makeRequest());

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "a slow but complete reply");
});

test("a success status with an unparseable body is an invalid response", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected token");
    },
  });
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorKind, "invalid_response");
});

test("unsupported success shapes are refused rather than guessed at", async () => {
  const bodies: unknown[] = [
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { content: [{ type: "text", text: "hi" }] } }] },
    { choices: [{ message: { tool_calls: [{ id: "1" }] } }] },
    "not an object",
  ];
  for (const body of bodies) {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, body));
    const result = await provider(fetchImpl).generate(makeRequest());
    assert.equal(result.ok, false, JSON.stringify(body));
    if (!result.ok) assert.equal(result.errorKind, "invalid_response");
  }
});

test("a provider error body is never copied into the failure detail", async () => {
  const planted = "PROVIDER-BODY-SHOULD-NOT-APPEAR";
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(500, { error: { message: planted } }),
  );
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(!result.detail.includes(planted));
});

// --- success ---------------------------------------------------------------

test("a valid response yields the reply text", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, okBody("A reply.")));
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "A reply.");
});

test("the served model comes from response metadata", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(200, okBody("hi", "actually-served-model")),
  );
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.servedModel, "actually-served-model");
});

test("absent model metadata leaves the served model unknown", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(200, { choices: [{ message: { content: "hi" } }] }),
  );
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.servedModel, null);
});

test("only the first choice is used", async () => {
  const { fetchImpl } = stubFetch(() =>
    jsonResponse(200, {
      model: "m",
      choices: [
        { message: { content: "first" } },
        { message: { content: "second" } },
      ],
    }),
  );
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "first");
});

test("an empty reply reaches the caller unchanged, for the sanitizer to judge", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(200, okBody("")));
  const result = await provider(fetchImpl).generate(makeRequest());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "");
});

// --- no retries ------------------------------------------------------------

test("a failure is not retried", async () => {
  // A retry can duplicate a paid request and hide the original failure.
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(500, {}));
  await provider(fetchImpl).generate(makeRequest());
  assert.equal(calls.length, 1);
});

test("exactly one request is made per generate call", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, okBody("hi")));
  const p = provider(fetchImpl);
  await p.generate(makeRequest());
  await p.generate(makeRequest());
  assert.equal(calls.length, 2);
});

test("the provider name is functional and stable", () => {
  assert.equal(provider(stubFetch(() => jsonResponse(200, {})).fetchImpl).name, PROVIDER_NAME);
  assert.equal(PROVIDER_NAME, "openai-compatible");
});
