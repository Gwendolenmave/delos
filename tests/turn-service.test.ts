/**
 * turn-service - synthetic tests.
 *
 * The provider is always a stub. No test reaches a network, and no fixture
 * resembles real conversation material.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTurnService } from "../core/services/turn-service.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelErrorKind,
} from "../core/ports/model-provider.js";
import { MODEL_ERROR_KINDS } from "../core/ports/model-provider.js";
import type { ChatMessage, PromptBundle } from "../core/domain/types.js";

const BUNDLE: PromptBundle = {
  sections: [
    { name: "identity", sha256: "0".repeat(64), content: "You are a test assistant.\n" },
    { name: "response-style", sha256: "1".repeat(64), content: "Be brief.\n" },
  ],
};

const EXPECTED_SYSTEM = "You are a test assistant.\n\nBe brief.";

function stubProvider(
  respond: (request: ModelRequest) => ModelResult | Promise<ModelResult>,
): { provider: ModelProvider; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    provider: {
      name: "stub",
      async generate(request) {
        calls.push(request);
        return respond(request);
      },
    },
  };
}

const okReply = (text: string) => (): ModelResult => ({ ok: true, text });

function service(
  provider: ModelProvider,
  maxEstimatedTokens = 10_000,
) {
  return createTurnService({
    provider,
    promptBundle: BUNDLE,
    recentWindow: { maxEstimatedTokens, estimator: () => 10 },
  });
}

const HISTORY: readonly ChatMessage[] = [
  { role: "user", text: "First question." },
  { role: "assistant", text: "First answer." },
];

function input(overrides: Partial<Parameters<ReturnType<typeof service>["runTurn"]>[0]> = {}) {
  return {
    conversationId: "conv-1",
    turnId: "turn-1",
    history: HISTORY,
    userText: "Second question.",
    ...overrides,
  };
}

// --- happy path ------------------------------------------------------------

test("a normal turn returns the sanitized reply", async () => {
  const { provider } = stubProvider(okReply("A reply."));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.replyText, "A reply.");
});

test("the prompt bundle is assembled once, at construction", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  const s = service(provider);
  await s.runTurn(input());
  await s.runTurn(input({ turnId: "turn-2" }));
  assert.equal(calls[0]?.systemPrompt, EXPECTED_SYSTEM);
  assert.equal(calls[1]?.systemPrompt, EXPECTED_SYSTEM);
});

test("the system prompt never enters the dialogue array", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(input());
  for (const message of calls[0]?.messages ?? []) {
    assert.notEqual(message.text, EXPECTED_SYSTEM);
  }
});

test("identifiers are passed to the port unchanged", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(
    input({ conversationId: "conv-abc", turnId: "turn-xyz" }),
  );
  assert.equal(calls[0]?.conversationId, "conv-abc");
  assert.equal(calls[0]?.turnId, "turn-xyz");
});

test("a per-turn model override is forwarded; absence sends none", async () => {
  const withModel = stubProvider(okReply("hi"));
  await service(withModel.provider).runTurn(input({ model: "other-model" }));
  assert.equal(withModel.calls[0]?.model, "other-model");

  const without = stubProvider(okReply("hi"));
  await service(without.provider).runTurn(input());
  assert.equal(without.calls[0]?.model, undefined);
});

// --- history and the current message ---------------------------------------

test("all history is sent when the budget allows", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(input());
  assert.deepEqual(calls[0]?.messages.map((m) => m.text), [
    "First question.",
    "First answer.",
    "Second question.",
  ]);
});

test("only a recent suffix is sent when the budget is small", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider, 10).runTurn(input());
  assert.deepEqual(calls[0]?.messages.map((m) => m.text), [
    "First answer.",
    "Second question.",
  ]);
});

test("the current message survives even when no history fits", async () => {
  // It is appended after selection, so the budget can never drop it.
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider, 0).runTurn(input());
  assert.deepEqual(calls[0]?.messages.map((m) => m.text), ["Second question."]);
});

test("the current message is always last and is a user message", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(input());
  const messages = calls[0]?.messages ?? [];
  const last = messages[messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.text, "Second question.");
});

test("optional message id and timestamp are carried when supplied", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(
    input({ userMessageId: "m-9", atIso: "2020-01-01T00:00:00Z" }),
  );
  const messages = calls[0]?.messages ?? [];
  const last = messages[messages.length - 1];
  assert.equal(last?.messageId, "m-9");
  assert.equal(last?.atIso, "2020-01-01T00:00:00Z");
});

test("the caller's history array and messages are not modified", async () => {
  const history: ChatMessage[] = [
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
  ];
  const before = history.map((m) => ({ ...m }));
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(input({ history }));

  assert.deepEqual(history, before);
  assert.equal(history.length, 2);
  assert.notEqual(calls[0]?.messages, history);
});

test("two turns with different history do not influence each other", async () => {
  const { provider, calls } = stubProvider(okReply("hi"));
  const s = service(provider);
  await s.runTurn(input({ history: [{ role: "user", text: "alpha" }] }));
  await s.runTurn(input({ history: [{ role: "user", text: "beta" }] }));

  assert.deepEqual(calls[0]?.messages.map((m) => m.text), ["alpha", "Second question."]);
  assert.deepEqual(calls[1]?.messages.map((m) => m.text), ["beta", "Second question."]);
});

// --- current input ---------------------------------------------------------

test("current text is preserved exactly, including surrounding whitespace", async () => {
  const text = "  spaced\n\tand indented  ";
  const { provider, calls } = stubProvider(okReply("hi"));
  await service(provider).runTurn(input({ userText: text }));
  const messages = calls[0]?.messages ?? [];
  assert.equal(messages[messages.length - 1]?.text, text);
});

test("blank input is rejected before the provider is called", async () => {
  for (const blank of ["", "   ", "\n\t\n"]) {
    const { provider, calls } = stubProvider(okReply("hi"));
    const outcome = await service(provider).runTurn(input({ userText: blank }));
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0, "no request should have been made");
  }
});

test("a missing identifier fails before the provider is called", async () => {
  for (const overrides of [{ conversationId: "" }, { turnId: "  " }]) {
    const { provider, calls } = stubProvider(okReply("hi"));
    const outcome = await service(provider).runTurn(input(overrides));
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0);
  }
});

// --- failure mapping -------------------------------------------------------

test("every provider error kind maps to safe, provider-neutral text", async () => {
  for (const kind of MODEL_ERROR_KINDS) {
    const { provider } = stubProvider(
      (): ModelResult => ({ ok: false, errorKind: kind, detail: "raw operator detail" }),
    );
    const outcome = await service(provider).runTurn(input());
    assert.equal(outcome.ok, false, kind);
    if (!outcome.ok) {
      assert.ok(outcome.failure.length > 0, kind);
      assert.ok(
        !outcome.failure.includes("raw operator detail"),
        `${kind}: raw detail surfaced`,
      );
      assert.ok(!outcome.failure.toLowerCase().includes("http"), kind);
    }
  }
});

test("provider detail containing sensitive text is never surfaced", async () => {
  const planted = "PROVIDER-DETAIL-MUST-NOT-APPEAR";
  const { provider } = stubProvider(
    (): ModelResult => ({
      ok: false,
      errorKind: "provider_error" as ModelErrorKind,
      detail: planted,
    }),
  );
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(!outcome.failure.includes(planted));
});

test("an unexpected provider throw becomes one safe failure", async () => {
  const planted = "STACK-AND-URL-MUST-NOT-APPEAR";
  const provider: ModelProvider = {
    name: "faulty",
    async generate() {
      throw new Error(planted);
    },
  };
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(!outcome.failure.includes(planted));
    assert.ok(!outcome.failure.includes("Error"));
  }
});

// --- sanitization ----------------------------------------------------------

test("CRLF in a reply is normalised by the sanitizer", async () => {
  const { provider } = stubProvider(okReply("line one\r\nline two"));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.replyText, "line one\nline two");
    assert.ok(!outcome.replyText.includes("\r"));
  }
});

test("terminal control sequences are removed from a reply", async () => {
  const esc = String.fromCharCode(27);
  const { provider } = stubProvider(okReply(`${esc}[31mred${esc}[0m and plain`));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.replyText, "red and plain");
    assert.ok(!outcome.replyText.includes("31m"));
  }
});

test("an empty reply becomes a safe failure", async () => {
  const { provider } = stubProvider(okReply(""));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, false);
});

test("a control-only reply becomes a safe failure", async () => {
  const esc = String.fromCharCode(27);
  const { provider } = stubProvider(okReply(`${esc}[2J${esc}[H`));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, false);
});

test("no failure path returns raw model text", async () => {
  const planted = "RAW-MODEL-TEXT-MUST-NOT-APPEAR";
  const esc = String.fromCharCode(27);
  // Sanitizes to nothing visible, but the raw text must not be echoed.
  const { provider } = stubProvider(okReply(`${esc}]0;${planted}`));
  const outcome = await service(provider).runTurn(input());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(!outcome.failure.includes(planted));
});

// --- statelessness ---------------------------------------------------------

test("the service holds no history of its own", async () => {
  const { provider, calls } = stubProvider(okReply("reply"));
  const s = service(provider);
  await s.runTurn(input({ history: [] }));
  await s.runTurn(input({ history: [] }));

  // A service that accumulated would send more the second time.
  assert.equal(calls[0]?.messages.length, 1);
  assert.equal(calls[1]?.messages.length, 1);
});
