/**
 * model-provider port - contract shape tests.
 *
 * SCOPE, stated honestly: these tests exercise the port's SHAPE using one
 * synthetic in-process provider. They show that the contract is implementable
 * and that role boundaries survive it. They do NOT establish how any real
 * adapter behaves. Whether adapters return typed failures rather than
 * throwing, retry correctly, or are idempotent must be proven by that
 * adapter's own tests, or by a reusable adapter conformance suite, once a
 * real adapter exists.
 *
 * All data here is synthetic. No fixture derives from a real conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_ERROR_KINDS } from "../core/ports/model-provider.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../core/ports/model-provider.js";
import type {
  ChatMessage,
  PromptBundle,
  TurnOutcome,
} from "../core/domain/types.js";

/**
 * A synthetic provider. It never reaches the network. It reports failures as
 * values because the contract says to; that is this fake honouring the
 * contract, not evidence about real adapters.
 */
class RecordingProvider implements ModelProvider {
  readonly name = "recording";

  calls: ModelRequest[] = [];

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.calls.push(request);
    const last = request.messages[request.messages.length - 1];
    if (last === undefined) {
      return { ok: false, errorKind: "invalid_response", detail: "no messages" };
    }
    if (last.role !== "user") {
      return {
        ok: false,
        errorKind: "invalid_response",
        detail: `last message must be from the user, got ${last.role}`,
      };
    }
    return {
      ok: true,
      text: `reply to: ${last.text}`,
      servedModel: "synthetic-recording-1",
    };
  }
}

const HISTORY: ChatMessage[] = [
  { role: "user", text: "First question.", messageId: "m-0001" },
  { role: "assistant", text: "First answer.", messageId: "m-0002" },
];

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    conversationId: "conv-synthetic-0001",
    turnId: "turn-synthetic-0001",
    systemPrompt: "You are a test assistant.",
    messages: [
      ...HISTORY,
      { role: "user", text: "Second question.", messageId: "m-0003" },
    ],
    ...overrides,
  };
}

test("the port is implementable by a provider", async () => {
  const provider: ModelProvider = new RecordingProvider();
  const result = await provider.generate(makeRequest());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "reply to: Second question.");
    assert.equal(result.servedModel, "synthetic-recording-1");
  }
});

test("the system prompt is carried outside the message list", async () => {
  const provider = new RecordingProvider();
  await provider.generate(makeRequest({ systemPrompt: "SYSTEM AUTHORITY" }));

  const seen = provider.calls[0];
  assert.ok(seen);
  assert.equal(seen.systemPrompt, "SYSTEM AUTHORITY");
  // The system prompt must not have leaked into the dialogue.
  for (const message of seen.messages) {
    assert.notEqual(message.text, "SYSTEM AUTHORITY");
  }
});

test("the last message is the current user input", async () => {
  const provider = new RecordingProvider();
  await provider.generate(makeRequest());

  const seen = provider.calls[0];
  assert.ok(seen);
  const last = seen.messages[seen.messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.text, "Second question.");
});

test("roles and order survive the contract without confusion", async () => {
  const provider = new RecordingProvider();
  await provider.generate(makeRequest());

  const seen = provider.calls[0];
  assert.ok(seen);
  assert.deepEqual(
    seen.messages.map((m) => [m.role, m.text]),
    [
      ["user", "First question."],
      ["assistant", "First answer."],
      ["user", "Second question."],
    ],
  );
});

test("assistant history is never re-attributed to the user", async () => {
  const provider = new RecordingProvider();
  await provider.generate(makeRequest());

  const seen = provider.calls[0];
  assert.ok(seen);
  const assistantTexts = seen.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.text);
  const userTexts = seen.messages
    .filter((m) => m.role === "user")
    .map((m) => m.text);

  assert.deepEqual(assistantTexts, ["First answer."]);
  assert.ok(!userTexts.includes("First answer."));
});

test("a turn ending in an assistant message is rejected, not silently accepted", async () => {
  const provider = new RecordingProvider();
  const result = await provider.generate(
    makeRequest({
      messages: [{ role: "assistant", text: "Dangling answer." }],
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, "invalid_response");
  }
});

test("this provider reports failure as a typed value carrying a detail", async () => {
  const provider = new RecordingProvider();
  const result = await provider.generate(makeRequest({ messages: [] }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, "invalid_response");
    assert.equal(typeof result.detail, "string");
    assert.ok(result.detail.length > 0);
  }
});

test("error kinds name a condition, never a transport mechanism", () => {
  // Imported from the port, never restated here. A copy would let someone add
  // a member without updating the rule, and the test would still pass.
  const mechanismWords = [
    "spawn", "exit", "stdout", "stderr", "http", "socket", "process", "pipe",
  ];

  assert.ok(MODEL_ERROR_KINDS.length > 0, "the error-kind list is empty");
  for (const kind of MODEL_ERROR_KINDS) {
    for (const word of mechanismWords) {
      assert.ok(
        !kind.includes(word),
        `error kind "${kind}" names the mechanism "${word}"`,
      );
    }
  }
});

test("every declared error kind is a distinct, usable value", () => {
  assert.equal(
    new Set(MODEL_ERROR_KINDS).size,
    MODEL_ERROR_KINDS.length,
    "duplicate error kind",
  );
  for (const kind of MODEL_ERROR_KINDS) {
    const failure: ModelResult = { ok: false, errorKind: kind, detail: "x" };
    assert.equal(failure.ok, false);
  }
});

test("the request carries the turn id through unchanged", async () => {
  // This shows pass-through only. It is NOT an idempotency test: proving a
  // provider is idempotent requires a real adapter and observable side
  // effects, which v0.1 does not yet have.
  const provider = new RecordingProvider();
  await provider.generate(makeRequest({ turnId: "turn-synthetic-0042" }));

  assert.equal(provider.calls[0]?.turnId, "turn-synthetic-0042");
});

test("domain types compose into a prompt bundle and a message list", () => {
  // Source-agnostic: no file path is required to build one. A section may come
  // from a directory, an editor, or an imported bundle.
  const bundle: PromptBundle = {
    sections: [
      {
        name: "identity",
        sha256: "0".repeat(64),
        content: "You are a test assistant.",
      },
    ],
  };

  assert.equal(bundle.sections.length, 1);
  assert.equal(bundle.sections[0]?.name, "identity");
  assert.equal(bundle.sections[0]?.sha256.length, 64);
});

test("a turn outcome discriminates on ok without inspecting other fields", () => {
  const success: TurnOutcome = { ok: true, replyText: "A reply." };
  const failure: TurnOutcome = { ok: false, failure: "Provider unavailable." };

  assert.equal(success.ok ? success.replyText : null, "A reply.");
  assert.equal(failure.ok ? null : failure.failure, "Provider unavailable.");
});
