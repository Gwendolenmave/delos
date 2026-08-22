/**
 * Turn coordinator - the Phase 3 idempotency and crash proofs.
 *
 * The provider is a counting fake: every test's core assertion is how many
 * times the model was ACTUALLY called. Crashes are simulated by driving the
 * store to the state a crash would leave and running recovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSqliteTranscriptStore } from "../adapters/transcripts/sqlite-transcript-store.js";
import { createTurnCoordinator, type TurnSubmission } from "../core/services/turn-coordinator.js";
import type { ModelProvider, ModelRequest } from "../core/ports/model-provider.js";
import type { TranscriptStore } from "../core/ports/transcript-store.js";

function harness(overrides: {
  generate?: ModelProvider["generate"];
  deliver?: (surface: string, key: string, text: string) => Promise<void>;
} = {}) {
  let n = 0;
  const store = createSqliteTranscriptStore({ path: ":memory:", newId: (p) => `${p}-${++n}` });
  let calls = 0;
  const provider: ModelProvider = {
    name: "fake",
    generate:
      overrides.generate ??
      (async () => {
        calls++;
        return { ok: true, text: `Reply ${calls}.` };
      }),
  };
  const delivered: string[] = [];
  const deliver =
    overrides.deliver ??
    (async (_s: string, _k: string, text: string) => {
      delivered.push(text);
    });
  let t = 0;
  const coordinator = createTurnCoordinator({
    store,
    provider,
    deliver,
    nowIso: () => `2026-08-01T10:00:${String(t++).padStart(2, "0")}.000Z`,
  });
  return { store, coordinator, delivered, modelCalls: () => calls };
}

async function conversationIn(store: TranscriptStore) {
  return store.createConversation(
    { title: "T", personaId: "arti", providerProfileId: "local", surface: "web" }, // scan-allow-persona
    "2026-08-01T09:00:00.000Z",
  );
}

function submission(conversationId: string, key: string, extra: Partial<TurnSubmission> = {}): TurnSubmission {
  return {
    surface: "web",
    externalConversationKey: "tab-1",
    externalTurnKey: key,
    conversationId,
    userText: `Message for ${key}`,
    buildRequest: async (userText): Promise<ModelRequest> => ({
      conversationId,
      turnId: key,
      systemPrompt: "You are synthetic.",
      messages: [{ role: "user", text: userText }],
    }),
    ...extra,
  };
}

test("a clean turn: model once, delivered once, states walked in order", async () => {
  const h = harness();
  const c = await conversationIn(h.store);
  const outcome = await h.coordinator.submit(submission(c.id, "k1"));
  assert.deepEqual(outcome, { kind: "completed", assistantText: "Reply 1.", reused: false });
  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(h.delivered, ["Reply 1."]);
  const messages = await h.store.listMessages(c.id);
  assert.deepEqual(messages.map((m) => [m.role, m.state]), [
    ["user", "delivered"],
    ["assistant", "delivered"],
  ]);
});

test("a sequential duplicate reuses the stored result; the model runs once", async () => {
  const h = harness();
  const c = await conversationIn(h.store);
  await h.coordinator.submit(submission(c.id, "k1"));
  const again = await h.coordinator.submit(submission(c.id, "k1"));
  assert.deepEqual(again, { kind: "completed", assistantText: "Reply 1.", reused: true });
  assert.equal(h.modelCalls(), 1, "the model was called twice for one turn");
  assert.equal((await h.store.listMessages(c.id)).length, 2, "no duplicate messages");
});

test("concurrent duplicates join one in-flight turn", async () => {
  const h = harness({
    generate: (() => {
      let calls = 0;
      return async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true as const, text: `Slow reply ${calls}.` };
      };
    })(),
  });
  const c = await conversationIn(h.store);
  const [a, b, d] = await Promise.all([
    h.coordinator.submit(submission(c.id, "k1")),
    h.coordinator.submit(submission(c.id, "k1")),
    h.coordinator.submit(submission(c.id, "k1")),
  ]);
  for (const outcome of [a, b, d]) {
    assert.equal(outcome.kind, "completed");
    if (outcome.kind === "completed") assert.equal(outcome.assistantText, "Slow reply 1.");
  }
  assert.equal((await h.store.listMessages(c.id)).length, 2);
});

test("provider failure creates no assistant message and no false completion", async () => {
  const h = harness({
    generate: async () => ({ ok: false as const, errorKind: "provider_error" as const, detail: "synthetic upstream error" }),
  });
  const c = await conversationIn(h.store);
  const outcome = await h.coordinator.submit(submission(c.id, "k1"));
  assert.equal(outcome.kind, "failed");
  const messages = await h.store.listMessages(c.id);
  assert.deepEqual(messages.map((m) => m.role), ["user"], "a failed request must not fabricate an answer");
});

test("delivery failure keeps the result and never regenerates", async () => {
  let deliverAttempts = 0;
  const h = harness({
    deliver: async () => {
      deliverAttempts++;
      throw new Error("surface unreachable");
    },
  });
  const c = await conversationIn(h.store);
  const outcome = await h.coordinator.submit(submission(c.id, "k1"));
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.equal(outcome.stage, "after-model");
  assert.equal(h.modelCalls(), 1);

  // The duplicate reports the stored situation; the model still ran once.
  const again = await h.coordinator.submit(submission(c.id, "k1"));
  assert.equal(again.kind, "failed");
  assert.equal(h.modelCalls(), 1, "delivery failure triggered regeneration");
  assert.equal(deliverAttempts, 1);
});

test("crash between completion and delivery: recovery redelivers without the model", async () => {
  const h = harness();
  const c = await conversationIn(h.store);
  // Simulate the crash point: assistant stored, turn at model-completed.
  const { record } = await h.store.beginExternalTurn("web", "tab-1", "k1", c.id, "2026-08-01T09:01:00.000Z");
  await h.store.setExternalTurnState(record.id, "accepted", "2026-08-01T09:01:01.000Z");
  await h.store.setExternalTurnState(record.id, "model-pending", "2026-08-01T09:01:02.000Z");
  const assistant = await h.store.appendMessage(
    { conversationId: c.id, role: "assistant", text: "Answer from before the crash.", state: "model-completed", externalTurnId: record.id },
    "2026-08-01T09:01:03.000Z",
  );
  await h.store.setExternalTurnState(record.id, "model-completed", "2026-08-01T09:01:04.000Z", assistant.id);

  const actions = await h.coordinator.recover();
  assert.deepEqual(actions, [{ turnId: record.id, action: "redelivered" }]);
  assert.deepEqual(h.delivered, ["Answer from before the crash."]);
  assert.equal(h.modelCalls(), 0, "recovery touched the model");
  assert.equal((await h.store.getExternalTurn(record.id)).state, "delivered");
});

test("crash before or during the model: recovery fails the turn, never regenerates", async () => {
  const h = harness();
  const c = await conversationIn(h.store);
  const { record } = await h.store.beginExternalTurn("web", "tab-1", "k1", c.id, "2026-08-01T09:01:00.000Z");
  await h.store.setExternalTurnState(record.id, "accepted", "2026-08-01T09:01:01.000Z");
  await h.store.setExternalTurnState(record.id, "model-pending", "2026-08-01T09:01:02.000Z");

  const actions = await h.coordinator.recover();
  assert.deepEqual(actions, [{ turnId: record.id, action: "abandoned" }]);
  assert.equal((await h.store.getExternalTurn(record.id)).state, "failed-before-model");
  assert.equal(h.modelCalls(), 0, "recovery silently regenerated a turn the user may have given up on");
});

test("turns serialise per conversation but conversations run concurrently", async () => {
  const order: string[] = [];
  const h = harness({
    generate: (() => {
      let calls = 0;
      return async (request: ModelRequest) => {
        calls++;
        order.push(`start:${request.turnId}`);
        await new Promise((r) => setTimeout(r, request.turnId.includes("slow") ? 60 : 5));
        order.push(`end:${request.turnId}`);
        return { ok: true as const, text: `ok ${calls}` };
      };
    })(),
  });
  const a = await conversationIn(h.store);
  const b = await conversationIn(h.store);

  await Promise.all([
    h.coordinator.submit(submission(a.id, "a-slow-1")),
    h.coordinator.submit(submission(a.id, "a-2")),
    h.coordinator.submit(submission(b.id, "b-1", { externalConversationKey: "tab-2" })),
  ]);

  // Within conversation a: a-slow-1 fully precedes a-2.
  assert.ok(order.indexOf("end:a-slow-1") < order.indexOf("start:a-2"), `lane broke: ${order.join(",")}`);
  // Conversation b overlapped a's slow turn rather than queueing behind it.
  assert.ok(order.indexOf("start:b-1") < order.indexOf("end:a-slow-1"), `no concurrency: ${order.join(",")}`);
});

test("telegram-shaped redelivery: same update id answered from the store", async () => {
  const h = harness();
  const c = await conversationIn(h.store);
  const telegramTurn = (key: string) =>
    submission(c.id, key, { surface: "telegram", externalConversationKey: "chat-77" });
  await h.coordinator.submit(telegramTurn("update-1001"));
  const redelivered = await h.coordinator.submit(telegramTurn("update-1001"));
  assert.equal(redelivered.kind, "completed");
  if (redelivered.kind === "completed") assert.equal(redelivered.reused, true);
  assert.equal(h.modelCalls(), 1);
});
