/**
 * SQLite transcript store - the Phase 3 gate proofs.
 *
 * Restart persistence uses a real temporary file reopened by a second store
 * instance. Everything else runs on :memory:. All content synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createSqliteTranscriptStore,
  MIGRATIONS,
  runMigrations,
  type Migration,
} from "../adapters/transcripts/sqlite-transcript-store.js";
import {
  TranscriptStoreError,
  type TranscriptStore,
} from "../core/ports/transcript-store.js";

const T0 = "2026-08-01T10:00:00.000Z";
const T1 = "2026-08-01T10:01:00.000Z";

function memoryStore(): TranscriptStore {
  let n = 0;
  return createSqliteTranscriptStore({ path: ":memory:", newId: (p) => `${p}-${++n}` });
}

async function withConversation(store: TranscriptStore) {
  return store.createConversation(
    { title: "Synthetic conversation", personaId: "arti", providerProfileId: "local", surface: "cli" }, // scan-allow-persona
    T0,
  );
}

// --- restart persistence -----------------------------------------------------

test("conversations and messages survive a real close-and-reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-sqlite-"));
  const path = join(dir, "transcripts.db");
  try {
    let n = 0;
    const first = createSqliteTranscriptStore({ path, newId: (p) => `${p}-a${++n}` });
    const conversation = await withConversation(first);
    await first.appendMessage(
      { conversationId: conversation.id, role: "user", text: "Before restart.", state: "delivered" },
      T0,
    );
    await first.close();

    let m = 0;
    const second = createSqliteTranscriptStore({ path, newId: (p) => `${p}-b${++m}` });
    const conversations = await second.listConversations();
    assert.equal(conversations.length, 1);
    const messages = await second.listMessages(conversations[0]!.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "Before restart.");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(":memory: is the non-persistent session", async () => {
  const store = memoryStore();
  await withConversation(store);
  await store.close();
  const again = memoryStore();
  assert.equal((await again.listConversations()).length, 0);
  await again.close();
});

// --- ordering and lifecycle --------------------------------------------------

test("ordinals are stable, per conversation, dense from 1", async () => {
  const store = memoryStore();
  const a = await withConversation(store);
  const b = await withConversation(store);
  for (let i = 0; i < 3; i++) {
    await store.appendMessage({ conversationId: a.id, role: "user", text: `a${i}`, state: "delivered" }, T0);
  }
  await store.appendMessage({ conversationId: b.id, role: "user", text: "b0", state: "delivered" }, T0);
  const inA = await store.listMessages(a.id);
  assert.deepEqual(inA.map((x) => x.ordinal), [1, 2, 3]);
  assert.deepEqual((await store.listMessages(b.id)).map((x) => x.ordinal), [1]);
  await store.close();
});

test("create, rename, archive, export, delete; deletion removes messages", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  await store.renameConversation(conversation.id, "Renamed", T1);
  await store.archiveConversation(conversation.id, true, T1);
  assert.equal((await store.listConversations()).length, 0, "archived hidden by default");
  assert.equal((await store.listConversations(true)).length, 1);

  await store.appendMessage({ conversationId: conversation.id, role: "user", text: "hello", state: "delivered" }, T0);
  const exported = JSON.parse(await store.exportConversation(conversation.id)) as {
    conversation: { title: string };
    messages: unknown[];
  };
  assert.equal(exported.conversation.title, "Renamed");
  assert.equal(exported.messages.length, 1);

  await store.deleteConversation(conversation.id);
  await assert.rejects(() => store.listMessages(conversation.id), TranscriptStoreError);
  await store.close();
});

// --- state machine -----------------------------------------------------------

test("assistant turn states follow the legal machine only", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  const message = await store.appendMessage(
    { conversationId: conversation.id, role: "assistant", text: "", state: "model-pending" },
    T0,
  );
  await store.setMessageState(message.id, "model-completed", T1);
  await assert.rejects(
    () => store.setMessageState(message.id, "model-pending", T1),
    (e: unknown) => e instanceof TranscriptStoreError && e.code === "invalid_transition",
  );
  await store.close();
});

test("interrupted, failed and completed states are all expressible and distinct", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  for (const state of ["failed-before-model", "failed-after-model", "cancelled", "delivered"] as const) {
    const message = await store.appendMessage(
      { conversationId: conversation.id, role: "assistant", text: "", state },
      T0,
    );
    assert.equal((await store.listMessages(conversation.id)).find((m) => m.id === message.id)?.state, state);
  }
  await store.close();
});

// --- migrations --------------------------------------------------------------

test("a failing migration rolls back atomically to the previous version", () => {
  const db = new DatabaseSync(":memory:");
  const version = runMigrations(db, MIGRATIONS);
  assert.equal(version, 1);

  const broken: Migration = {
    version: 2,
    up: "CREATE TABLE extra (id TEXT); CREATE TABLE conversations (dup TEXT);", // second stmt fails
  };
  assert.throws(
    () => runMigrations(db, [...MIGRATIONS, broken]),
    (e: unknown) => e instanceof TranscriptStoreError && e.code === "migration_failed",
  );
  // version unchanged AND the partial DDL from the broken migration is gone
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
  assert.equal(row.version, 1);
  const extra = db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get();
  assert.equal(extra, undefined, "partial DDL survived the rollback");
  db.close();
});

test("reopening an already-migrated database is a no-op, not a re-run", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(runMigrations(db, MIGRATIONS), 1);
  assert.equal(runMigrations(db, MIGRATIONS), 1, "idempotent");
  db.close();
});

// --- external-turn idempotency ----------------------------------------------

test("the same external key returns the same turn; a new key creates one", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  const first = await store.beginExternalTurn("telegram", "chat-9", "update-1", conversation.id, T0);
  assert.equal(first.existed, false);
  const again = await store.beginExternalTurn("telegram", "chat-9", "update-1", conversation.id, T1);
  assert.equal(again.existed, true);
  assert.equal(again.record.id, first.record.id);

  const other = await store.beginExternalTurn("telegram", "chat-9", "update-2", conversation.id, T1);
  assert.equal(other.existed, false);
  assert.notEqual(other.record.id, first.record.id);
  await store.close();
});

test("concurrent duplicate submissions converge on one turn", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.beginExternalTurn("web", "tab-1", "idem-key-1", conversation.id, T0),
    ),
  );
  const ids = new Set(results.map((r) => r.record.id));
  assert.equal(ids.size, 1, "duplicates diverged into separate turns");
  assert.equal(results.filter((r) => !r.existed).length, 1, "exactly one creation");
  await store.close();
});

test("recovery listing returns pending turns after a simulated crash", async () => {
  const store = memoryStore();
  const conversation = await withConversation(store);
  const { record } = await store.beginExternalTurn("web", "tab-1", "k1", conversation.id, T0);
  await store.setExternalTurnState(record.id, "accepted", T0);
  await store.setExternalTurnState(record.id, "model-pending", T0);

  const done = await store.beginExternalTurn("web", "tab-1", "k2", conversation.id, T0);
  await store.setExternalTurnState(done.record.id, "failed-before-model", T0);

  const recoverable = await store.listRecoverableTurns();
  assert.deepEqual(recoverable.map((t) => t.id), [record.id], "terminal states are not recoverable");
  await store.close();
});

// --- provider observations ---------------------------------------------------

test("served-model match, mismatch and unknown are stored as evidence, not guesses", async () => {
  const store = memoryStore();
  const base = {
    profileId: "local",
    configuredModel: "model-a",
    requestedModel: "model-a",
    protocol: "openai-chat-completions",
    atIso: T0,
  };
  await store.recordObservation({ ...base, servedModel: "model-a", evidenceSource: "provider-metadata" });
  await store.recordObservation({ ...base, servedModel: "model-b", evidenceSource: "provider-metadata" });
  await store.recordObservation({ ...base, evidenceSource: "protocol-behaviour", capability: "cancellation" });

  const observations = await store.listObservations("local");
  assert.equal(observations.length, 3);
  assert.equal(observations[0]?.servedModel, "model-a");
  assert.equal(observations[1]?.servedModel, "model-b", "a mismatch is stored, not repaired");
  assert.equal(observations[2]?.servedModel, undefined, "unknown stays unknown");
  assert.equal(observations[2]?.capability, "cancellation");
  await store.close();
});
