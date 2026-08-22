import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMnemosyneMemoryContextProvider,
  MNEMOSYNE_PACKAGE_NAME,
  MnemosynePackageError,
} from "../adapters/memory/mnemosyne-package.js";
import { MemoryTurnReceiptStore } from "../adapters/memory/memory-turn-receipts.js";
import { createSqliteTranscriptStore } from "../adapters/transcripts/sqlite-transcript-store.js";
import type { ModelProvider, ModelRequest } from "../core/ports/model-provider.js";
import { deriveMemoryScene } from "../core/services/memory-scene.js";
import {
  createTurnCoordinator,
  type DeliveredTurnNotice,
} from "../core/services/turn-coordinator.js";
import type { VariantResolution } from "../core/services/variant-resolver.js";

function syntheticResolution(
  activeVariantIds: readonly string[],
  baseContent = "synthetic base",
): VariantResolution {
  return {
    personaId: "arti", // scan-allow-persona
    blocks: [
      {
        name: "identity",
        path: "base/identity.md",
        content: baseContent,
        reason: { kind: "base" },
        priority: 0,
      },
      ...activeVariantIds.map((id, index) => ({
        name: `variant:${id}`,
        path: `variants/${id}.md`,
        content: `synthetic ${id}`,
        reason: { kind: "manual" as const },
        priority: 10 + index,
      })),
    ],
    metadata: {
      activePersona: "arti", // scan-allow-persona
      surface: "web",
      baseBlocks: ["identity"],
      overlays: [],
      variants: activeVariantIds.map((id, index) => ({
        id,
        reason: "manually enabled",
        priority: 10 + index,
      })),
      inactive: [],
    },
  };
}

test("Mnemosyne adapter uses only the public package surface and returns pointer metadata", async () => {
  const store = { synthetic: true };
  let loaded = "";
  let opened = "";
  let closed = 0;
  const packetInputs: Record<string, unknown>[] = [];

  const provider = await createMnemosyneMemoryContextProvider({
    dbPath: "/synthetic/memory.db",
    loadPackage: async (specifier) => {
      loaded = specifier;
      return {
        SqliteMnemosyne: {
          openMnemosyne(path: unknown) {
            opened = String(path);
            return {
              store,
              log: { close: () => void (closed += 1) },
            };
          },
        },
        Anamnesis: {
          buildMemoryReadPacket(input: unknown) {
            packetInputs.push(input as Record<string, unknown>);
            return {
              priors: [{ key: "relationship", version: 3, body: "synthetic prior body" }],
              audit: { selected: [{ id: "memory-1" }, { id: "memory-2" }] },
            };
          },
          renderMemoryPacket() {
            return "synthetic remembered context";
          },
        },
      };
    },
  });

  const ordinary = await provider.retrieve("project milestone", "2026-08-22T00:00:00.000Z");
  assert.deepEqual(ordinary, {
    status: "ok",
    text: "synthetic remembered context",
    selectedIds: ["memory-1", "memory-2"],
    priorVersions: { relationship: 3 },
  });
  assert.equal(loaded, MNEMOSYNE_PACKAGE_NAME);
  assert.equal(opened, "/synthetic/memory.db");
  assert.equal(packetInputs[0]?.["source"], store);
  assert.equal(packetInputs[0]?.["query"], "project milestone");
  assert.equal(packetInputs[0]?.["nowIso"], "2026-08-22T00:00:00.000Z");
  assert.deepEqual(packetInputs[0]?.["scene"], { mode: "ordinary", intimacyActive: false });

  await provider.retrieve("scene query", "2026-08-22T00:01:00.000Z", {
    mode: "au",
    auId: "campus",
    intimacyActive: true,
  });
  assert.deepEqual(packetInputs[1]?.["scene"], {
    mode: "au",
    auId: "campus",
    intimacyActive: true,
  });

  await provider.retrieve("ambiguous query", "2026-08-22T00:02:00.000Z", {
    mode: "unknown",
    intimacyActive: true,
  });
  assert.deepEqual(
    packetInputs[2]?.["scene"],
    { mode: "ordinary", intimacyActive: true },
    "ambiguous host scene must narrow reads rather than leak one AU into another",
  );

  await provider.close?.();
  await provider.close?.();
  assert.equal(closed, 1);
});

test("Mnemosyne adapter keeps loader and retrieval internals out of errors", async () => {
  await assert.rejects(
    createMnemosyneMemoryContextProvider({
      dbPath: "/synthetic/memory.db",
      loadPackage: async () => {
        throw new Error("TOP SECRET loader detail");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MnemosynePackageError);
      assert.equal(error.kind, "package_unavailable");
      assert.doesNotMatch(error.message, /TOP SECRET/);
      return true;
    },
  );

  const provider = await createMnemosyneMemoryContextProvider({
    dbPath: "/synthetic/memory.db",
    loadPackage: async () => ({
      SqliteMnemosyne: {
        openMnemosyne: () => ({ store: {}, log: { close() {} } }),
      },
      Anamnesis: {
        buildMemoryReadPacket() {
          throw new Error("PRIVATE ROW CONTENT");
        },
        renderMemoryPacket() {
          return "unused";
        },
      },
    }),
  });
  const degraded = await provider.retrieve("query", "2026-08-22T00:00:00.000Z");
  assert.equal(degraded.status, "degraded");
  assert.doesNotMatch(degraded.detail, /PRIVATE ROW CONTENT/);
  await provider.close?.();
});

test("explicit persona variants deterministically project to memory scene and a stable variant hash", () => {
  const ordinary = deriveMemoryScene(syntheticResolution([]));
  assert.deepEqual(ordinary.scene, { mode: "ordinary", intimacyActive: false });

  const intimacy = deriveMemoryScene(syntheticResolution(["intimacy"]));
  assert.deepEqual(intimacy.scene, { mode: "ordinary", intimacyActive: true });

  const au = deriveMemoryScene(syntheticResolution(["intimacy", "au-campus"]));
  assert.deepEqual(au.scene, { mode: "au", auId: "campus", intimacyActive: true });

  const ambiguous = deriveMemoryScene(syntheticResolution(["au-campus", "au-space"]));
  assert.deepEqual(ambiguous.scene, { mode: "unknown", intimacyActive: false });

  const same = deriveMemoryScene(syntheticResolution(["au-campus"]));
  const sameAgain = deriveMemoryScene(syntheticResolution(["au-campus"]));
  assert.equal(same.variantSha256, sameAgain.variantSha256);
  assert.notEqual(
    same.variantSha256,
    deriveMemoryScene(syntheticResolution(["au-campus"], "changed base authority")).variantSha256,
  );
  assert.match(same.variantSha256, /^[a-f0-9]{64}$/);
});

test("memory turn receipts round-trip pointer metadata and recover pending ingress", async () => {
  const root = await mkdtemp(join(tmpdir(), "delos-memory-receipts-"));
  const receipts = new MemoryTurnReceiptStore(join(root, "receipts.db"));
  try {
    receipts.record({
      turnId: "turn-1",
      conversationId: "conversation-1",
      variantSha256: "a".repeat(64),
      scene: { mode: "au", auId: "campus", intimacyActive: true },
      selectedIds: ["memory-a", "memory-b"],
      priorVersions: { relationship: 4, style: 2 },
      sourceTime: "2026-08-22T00:00:00.000Z",
    });

    assert.equal(receipts.pending().length, 1);
    assert.deepEqual(receipts.get("turn-1"), {
      turnId: "turn-1",
      conversationId: "conversation-1",
      variantSha256: "a".repeat(64),
      scene: { mode: "au", auId: "campus", intimacyActive: true },
      selectedIds: ["memory-a", "memory-b"],
      priorVersions: { relationship: 4, style: 2 },
      sourceTime: "2026-08-22T00:00:00.000Z",
      enqueuedAt: null,
    });

    receipts.markEnqueued("turn-1", "2026-08-22T00:01:00.000Z");
    assert.equal(receipts.pending().length, 0);
    assert.equal(receipts.get("turn-1")?.enqueuedAt, "2026-08-22T00:01:00.000Z");

    receipts.record({
      turnId: "turn-2",
      conversationId: "conversation-1",
      variantSha256: "b".repeat(64),
      scene: { mode: "unknown", intimacyActive: false },
      selectedIds: [],
      priorVersions: {},
      sourceTime: "2026-08-22T00:02:00.000Z",
    });
    assert.deepEqual(receipts.get("turn-2")?.scene, { mode: "unknown", intimacyActive: false });
  } finally {
    receipts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("turn coordinator exposes the exact durable turn id and notifies only after delivery", async () => {
  let serial = 0;
  const store = createSqliteTranscriptStore({
    path: ":memory:",
    newId: (prefix) => `${prefix}-${++serial}`,
  });
  const conversation = await store.createConversation(
    {
      title: "Synthetic",
      personaId: "arti", // scan-allow-persona
      providerProfileId: "synthetic-provider",
      surface: "web",
    },
    "2026-08-22T00:00:00.000Z",
  );
  const notices: DeliveredTurnNotice[] = [];
  let durableTurnId = "";
  let delivered = false;
  const provider: ModelProvider = {
    name: "synthetic",
    async generate() {
      return { ok: true, text: "synthetic reply" };
    },
  };
  const coordinator = createTurnCoordinator({
    store,
    provider,
    deliver: async () => {
      delivered = true;
    },
    nowIso: () => "2026-08-22T00:00:01.000Z",
    onDelivered: async (notice) => {
      assert.equal(delivered, true, "sidecar notice must not precede user-visible delivery");
      notices.push(notice);
    },
  });

  const outcome = await coordinator.submit({
    surface: "web",
    externalConversationKey: conversation.id,
    externalTurnKey: "request-1",
    conversationId: conversation.id,
    userText: "hello",
    buildRequest: async (userText, turnId): Promise<ModelRequest> => {
      durableTurnId = turnId;
      return {
        conversationId: conversation.id,
        turnId: "provider-turn-1",
        systemPrompt: "synthetic system",
        messages: [{ role: "user", text: userText }],
      };
    },
  });

  assert.equal(outcome.kind, "completed");
  assert.notEqual(durableTurnId, "");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.turnId, durableTurnId);
  assert.equal((await store.getExternalTurn(durableTurnId)).state, "delivered");
  await store.close();
});

test("a failing post-delivery sidecar cannot turn a delivered chat turn into failure", async () => {
  let serial = 0;
  const store = createSqliteTranscriptStore({
    path: ":memory:",
    newId: (prefix) => `${prefix}-${++serial}`,
  });
  const conversation = await store.createConversation(
    {
      title: "Synthetic",
      personaId: "arti", // scan-allow-persona
      providerProfileId: "synthetic-provider",
      surface: "web",
    },
    "2026-08-22T00:00:00.000Z",
  );
  const coordinator = createTurnCoordinator({
    store,
    provider: {
      name: "synthetic",
      async generate() {
        return { ok: true, text: "reply survives sidecar failure" };
      },
    },
    deliver: async () => undefined,
    nowIso: () => "2026-08-22T00:00:01.000Z",
    onDelivered: async () => {
      throw new Error("synthetic sidecar failure");
    },
  });

  const outcome = await coordinator.submit({
    surface: "web",
    externalConversationKey: conversation.id,
    externalTurnKey: "request-1",
    conversationId: conversation.id,
    userText: "hello",
    buildRequest: async (userText): Promise<ModelRequest> => ({
      conversationId: conversation.id,
      turnId: "provider-turn-1",
      systemPrompt: "synthetic system",
      messages: [{ role: "user", text: userText }],
    }),
  });
  assert.deepEqual(outcome, {
    kind: "completed",
    assistantText: "reply survives sidecar failure",
    reused: false,
  });
  await store.close();
});
