/**
 * The Phase 4 gate, end to end: a real daemon with PRODUCTION fetch (no
 * injected fetchImpl) against real loopback provider servers speaking both
 * wire protocols, driven only through the typed client - the same calls the
 * web UI makes. Includes the restart-and-continue proof and durable
 * idempotency across a daemon restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { startDaemon } from "../surfaces/daemon/daemon.js";
import { DelosClient } from "../surfaces/api-client/client.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");

interface Loopback {
  origin: string;
  calls: number;
  close(): Promise<void>;
}

async function loopbackProvider(
  respond: (n: number, url: string, res: ServerResponse) => void,
): Promise<Loopback> {
  const state = { calls: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.calls++;
      respond(state.calls, req.url ?? "", res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as Loopback;
}

test("phase 4 gate: onboarding, both protocols, variants, restart, idempotency", async () => {
  // Two REAL provider servers, one per wire protocol.
  const openaiCompatible = await loopbackProvider((n, _url, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: "served-oc",
        choices: [{ message: { role: "assistant", content: `OC reply ${n}.` } }],
      }),
    );
  });
  const anthropicCompatible = await loopbackProvider((n, url, res) => {
    assert.equal(url, "/v1/messages");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: "served-ac",
        content: [{ type: "text", text: `AC reply ${n}.` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });

  const dataDir = await mkdtemp(join(tmpdir(), "delos-gate4-"));
  try {
    // --- first daemon lifetime: onboarding and two turns --------------------
    let daemon = await startDaemon({ dataDir, shippedPersonaDir: SHIPPED, env: {} });
    let client = new DelosClient({ origin: daemon.origin, sessionToken: daemon.sessionToken });
    await client.connect();

    // onboarding step 1: create both providers through the API
    await client.createProvider({
      schemaVersion: 1,
      id: "oc",
      kind: "openai-compatible",
      model: "oc-model",
      baseUrl: `${openaiCompatible.origin}/v1`,
      auth: { transport: "none" },
    });
    await client.createProvider({
      schemaVersion: 1,
      id: "ac",
      kind: "anthropic-compatible",
      model: "ac-model",
      baseUrl: anthropicCompatible.origin,
      auth: { transport: "none" },
    });

    // step 2: connection-test both, through production fetch
    const ocProbe = await client.testProvider("oc");
    assert.equal(ocProbe.ok, true);
    assert.equal(ocProbe.servedModel, "served-oc");
    const acProbe = await client.testProvider("ac");
    assert.equal(acProbe.ok, true);
    assert.equal(acProbe.servedModel, "served-ac");
    assert.equal(acProbe.protocol, "anthropic-messages");

    // step 3: persona - import a pasted prompt AND use the shipped pack
    await client.createPersonaFromPaste("gate-imported", "You are the gate persona.");

    // step 4: conversation on the anthropic-compatible provider, with the
    // shipped Arti pack so variants are real // scan-allow-persona
    const conversation = (
      await client.createConversation({ title: "Gate", personaId: "arti", providerProfileId: "ac" }) // scan-allow-persona
    ).conversation;

    // enable intimacy manually (the only way it can activate), disable again later
    await client.patchConversation(conversation.id, { manualEnabled: ["intimacy"] });

    const turn1 = await client.sendMessage(conversation.id, "Hello there.", "gate-turn-1");
    assert.equal(turn1.outcome.kind, "completed");
    const acCallsAfterProbe = anthropicCompatible.calls;

    const turn2 = await client.sendMessage(conversation.id, "And a second turn.", "gate-turn-2");
    assert.equal(turn2.outcome.kind, "completed");
    assert.equal(anthropicCompatible.calls, acCallsAfterProbe + 1);

    // real history read
    const history = await client.queryHistory(conversation.id, { kind: "keyword", literal: "hello", around: 0 });
    assert.equal(history.read, true);
    assert.equal(history.records.length, 1);

    // situation with a short expiry: alive now, gone after it passes
    const soon = new Date(Date.now() + 1200).toISOString();
    await client.createSituation("Only for a moment.", soon);
    assert.equal((await client.listSituations()).active.length, 1);
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal((await client.listSituations()).active.length, 0, "expiry did not take effect");

    const messagesBefore = (await client.listMessages(conversation.id)).messages;
    assert.equal(messagesBefore.length, 4);

    await daemon.close();

    // --- second daemon lifetime: restart and continue -----------------------
    daemon = await startDaemon({ dataDir, shippedPersonaDir: SHIPPED, env: {} });
    client = new DelosClient({ origin: daemon.origin, sessionToken: daemon.sessionToken });

    const conversations = await client.listConversations();
    assert.equal(conversations.conversations.length, 1, "the conversation survived restart");
    const messagesAfter = await client.listMessages(conversation.id);
    assert.equal(messagesAfter.messages.length, 4, "messages survived restart");

    // durable idempotency ACROSS the restart: the same key returns the stored
    // reply and the provider is not called again
    const callsBeforeDuplicate = anthropicCompatible.calls;
    const duplicate = await client.sendMessage(conversation.id, "Hello there.", "gate-turn-1");
    assert.equal(duplicate.outcome.reused, true);
    assert.equal(anthropicCompatible.calls, callsBeforeDuplicate, "a restart defeated idempotency");

    // and the conversation continues normally
    const turn3 = await client.sendMessage(conversation.id, "Continuing after restart.", "gate-turn-3");
    assert.equal(turn3.outcome.kind, "completed");

    await daemon.close();
  } finally {
    await openaiCompatible.close();
    await anthropicCompatible.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
