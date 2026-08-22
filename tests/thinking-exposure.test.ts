/**
 * B7: raw chain-of-thought / thinking text is NEVER exposed through any
 * surface. The enforcement point is the provider seam - containment runs
 * BEFORE persistence - so the stored transcript, the messages API, SSE
 * delivery, exports and backups are all clean by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon } from "../surfaces/daemon/daemon.js";
import type { FetchLike } from "../adapters/providers/shared/http-provider-core.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
const SECRET_THOUGHT = "the user seems lonely, exploit that";

function thinkingProvider(): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "served-model",
      choices: [
        {
          message: {
            role: "assistant",
            content: `<thinking>${SECRET_THOUGHT}</thinking>A kind, ordinary answer.`,
          },
        },
      ],
    }),
  });
}

test("B7: thinking text never reaches storage, the messages API, or export", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-b7-"));
  const daemon = await startDaemon({
    dataDir,
    shippedPersonaDir: SHIPPED,
    env: {},
    fetchImpl: thinkingProvider(),
    seedProfiles: [
      {
        schemaVersion: 1,
        id: "local",
        kind: "openai-compatible",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { transport: "none" },
      },
    ],
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${daemon.origin}${path}`, {
      method,
      headers: {
        "x-delos-session": daemon.sessionToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  try {
    const conversation = (
      (await call("POST", "/api/v1/conversations", {
        title: "B7",
        personaId: "arti", // scan-allow-persona
        providerProfileId: "local",
      })).json as { conversation: { id: string } }
    ).conversation;

    const turn = await call("POST", `/api/v1/conversations/${conversation.id}/messages`, {
      text: "hello",
      idempotencyKey: "b7-1",
    });
    const outcome = turn.json["outcome"] as { kind: string; assistantText: string };
    assert.equal(outcome.kind, "completed");
    assert.equal(outcome.assistantText, "A kind, ordinary answer.");
    assert.ok(!JSON.stringify(turn.json).includes(SECRET_THOUGHT), "the turn response leaked");

    // The STORED transcript is clean - not merely the rendered copy.
    const messages = (await call("GET", `/api/v1/conversations/${conversation.id}/messages`)).json as {
      messages: { role: string; text: string }[];
    };
    const assistant = messages.messages.find((m) => m.role === "assistant");
    assert.equal(assistant?.text, "A kind, ordinary answer.");
    assert.ok(!JSON.stringify(messages).includes(SECRET_THOUGHT), "the stored transcript leaked");

    // Export and backup read the same store; spot-check the export surface.
    const exported = await call("GET", `/api/v1/conversations/${conversation.id}/export`);
    assert.ok(!JSON.stringify(exported.json).includes(SECRET_THOUGHT), "the export leaked");

    const backup = await fetch(`${daemon.origin}/api/v1/backup`, {
      headers: { "x-delos-session": daemon.sessionToken },
    });
    const bytes = Buffer.from(await backup.arrayBuffer());
    assert.ok(!bytes.includes(SECRET_THOUGHT), "the backup archive leaked");
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
