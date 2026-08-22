/**
 * Typed client against a real daemon - the contract a future PWA inherits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../surfaces/daemon/daemon.js";
import { DelosClient, DelosApiError } from "../surfaces/api-client/client.js";
import type { FetchLike } from "../adapters/providers/shared/http-provider-core.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");

function stubProvider(): FetchLike {
  let n = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "served-model",
      choices: [{ message: { role: "assistant", content: `Reply ${++n}.` } }],
    }),
  });
}

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-client-"));
  const daemon = await startDaemon({
    dataDir,
    shippedPersonaDir: SHIPPED,
    env: {},
    seedProfiles: [
      {
        schemaVersion: 1,
        id: "local",
        kind: "openai-compatible",
        model: "local-model",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { transport: "none" },
      },
    ],
    fetchImpl: stubProvider(),
  });
  const client = new DelosClient({ origin: daemon.origin, sessionToken: daemon.sessionToken });
  return {
    client,
    daemon,
    close: async () => {
      await daemon.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("client: the handshake negotiates the API version", async () => {
  const h = await harness();
  try {
    const health = await h.client.connect();
    assert.equal(health.apiVersion, 1);
    assert.equal(health.ok, true);
  } finally {
    await h.close();
  }
});

test("client: a wrong token surfaces as a typed error, not a throw of soup", async () => {
  const h = await harness();
  try {
    const bad = new DelosClient({ origin: h.daemon.origin, sessionToken: "wrong" });
    await assert.rejects(
      () => bad.connect(),
      (e: unknown) => e instanceof DelosApiError && e.status === 401 && e.code === "unauthorized",
    );
  } finally {
    await h.close();
  }
});

test("client: the full first-run path through typed calls only", async () => {
  const h = await harness();
  try {
    // provider -> test -> persona -> conversation -> chat -> history
    const providers = await h.client.listProviders();
    assert.equal(providers.profiles[0]?.id, "local");

    const probe = await h.client.testProvider("local");
    assert.equal(probe.ok, true);
    assert.equal(probe.servedModel, "served-model");

    const personas = await h.client.listPersonas();
    assert.ok(personas.personas.some((p) => p.id === "arti")); // scan-allow-persona

    const created = await h.client.createPersonaFromWizard({
      id: "client-made",
      identity: "You are created through the typed client.",
    });
    assert.equal(created.id, "client-made");

    const conversation = await h.client.createConversation({
      title: "Typed",
      personaId: "client-made",
      providerProfileId: "local",
    });

    const events: string[] = [];
    const unsubscribe = await h.client.streamEvents(conversation.conversation.id, (e) =>
      events.push(e.event),
    );

    const outcome = await h.client.sendMessage(conversation.conversation.id, "Hello.", "k-1");
    assert.equal(outcome.outcome.kind, "completed");
    assert.equal(outcome.outcome.assistantText, "Reply 2.", "the probe consumed Reply 1");

    const duplicate = await h.client.sendMessage(conversation.conversation.id, "Hello.", "k-1");
    assert.equal(duplicate.outcome.reused, true);
    assert.equal(duplicate.outcome.assistantText, "Reply 2.");

    const history = await h.client.queryHistory(conversation.conversation.id, {
      kind: "recent",
      count: 10,
    });
    assert.equal(history.read, true);
    assert.equal(history.records.length, 2);

    await new Promise((r) => setTimeout(r, 50));
    unsubscribe();
    assert.ok(events.includes("turn-accepted"), `events: ${events.join(",")}`);
    assert.ok(events.includes("assistant-text"));

    // situations through the client
    const situation = await h.client.createSituation("Testing until tonight.", "2030-01-01T00:00:00.000Z");
    assert.equal(situation.situation.state, "active");
    const listed = await h.client.listSituations();
    assert.equal(listed.active.length, 1);
  } finally {
    await h.close();
  }
});
