/**
 * The Phase 6 gate, end to end through the daemon API: deterministic
 * backup, fresh restore, no secret inclusion, atomic rollback, restored
 * credential-required state, doctor states, webhook-conflict diagnosis, and
 * the redacted report. Fake providers, fake Bot API, loopback only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon, type RunningDaemon } from "../surfaces/daemon/daemon.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
const SECRET_VALUE = ["never", "in", "a", "backup", "9f8e7d6c5b4a"].join("-");

interface Harness {
  daemon: RunningDaemon;
  dataDir: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
  raw: (path: string) => Promise<Response>;
  close: () => Promise<void>;
}

async function harness(env: Record<string, string>, telegramApiOrigin?: string): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-gate6-"));
  const daemon = await startDaemon({
    dataDir,
    shippedPersonaDir: SHIPPED,
    env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "served-model",
        choices: [{ message: { role: "assistant", content: "A reply." } }],
      }),
    }),
    ...(telegramApiOrigin === undefined ? {} : { telegramApiOrigin }),
    seedProfiles: [
      {
        schemaVersion: 1,
        id: "envkey",
        kind: "openai-compatible",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { source: "environment", transport: "bearer", secretId: "provider:envkey", envVar: "GATE6_KEY" },
      },
    ],
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${daemon.origin}${path}`, {
      method,
      headers: {
        "x-delos-session": daemon.sessionToken,
        origin: daemon.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
  };
  const raw = (path: string) =>
    fetch(`${daemon.origin}${path}`, {
      headers: { "x-delos-session": daemon.sessionToken, origin: daemon.origin },
    });
  return {
    daemon,
    dataDir,
    api,
    raw,
    close: async () => {
      await daemon.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("phase 6 gate: backup determinism, no secrets, restore to a fresh machine, credential truth", async () => {
  const source = await harness({ GATE6_KEY: SECRET_VALUE });
  try {
    // Real state: a conversation with a real (stubbed-provider) turn.
    const created = (await source.api("POST", "/api/v1/conversations", {
      title: "Gate 6",
      personaId: "arti", // scan-allow-persona
      providerProfileId: "envkey",
    })) as { json: { conversation: { id: string } } };
    const conversationId = created.json.conversation.id;
    const turn = await source.api("POST", `/api/v1/conversations/${conversationId}/messages`, {
      text: "Hello.",
      idempotencyKey: "gate6-1",
    });
    assert.equal(turn.status, 200);
    await source.api("POST", "/api/v1/situations", {
      text: "Gate six is running.",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });

    // Deterministic: two consecutive backups are byte-identical.
    const first = Buffer.from(await (await source.raw("/api/v1/backup")).arrayBuffer());
    const second = Buffer.from(await (await source.raw("/api/v1/backup")).arrayBuffer());
    assert.ok(first.equals(second), "two backups of one state differ");

    // No secret inclusion: the configured env credential value is nowhere.
    assert.ok(!first.toString("latin1").includes(SECRET_VALUE), "the credential value leaked into the backup");

    const zipBase64 = first.toString("base64");

    // Fresh machine: a second daemon with an empty env - the same profile
    // must restore, and must honestly need its credential reconfigured.
    const target = await harness({});
    try {
      const inspected = await target.api("POST", "/api/v1/restore", { zipBase64, mode: "inspect" });
      assert.equal(inspected.status, 200);
      const preview = (inspected.json as { preview: { counts: Record<string, number> } }).preview;
      assert.equal(preview.counts["conversations"], 1);
      assert.equal(preview.counts["messages"], 2);

      const applied = await target.api("POST", "/api/v1/restore", { zipBase64, mode: "apply", policy: "replace" });
      assert.equal(applied.status, 200);
      const result = applied.json as { providersNeedingCredentials: string[]; verified: boolean };
      assert.equal(result.verified, true);
      assert.deepEqual(result.providersNeedingCredentials, ["envkey"]);

      // The restored conversation is really there, through the ordinary API.
      const conversations = (await target.api("GET", "/api/v1/conversations")).json as {
        conversations: { id: string; title: string }[];
      };
      assert.equal(conversations.conversations.length, 1);
      assert.equal(conversations.conversations[0]!.title, "Gate 6");
      const messages = (await target.api("GET", `/api/v1/conversations/${conversationId}/messages`)).json as {
        messages: unknown[];
      };
      assert.equal(messages.messages.length, 2);

      // And doctor on the target reports the missing credential as DEGRADED.
      const doctor = (await target.api("GET", "/api/v1/doctor")).json as {
        overall: string;
        checks: { id: string; status: string }[];
      };
      assert.equal(doctor.checks.find((c) => c.id === "providers")!.status, "DEGRADED");
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
});

test("phase 6 gate: a poisoned archive rolls back atomically through the API", async () => {
  const source = await harness({ GATE6_KEY: SECRET_VALUE });
  try {
    await source.api("POST", "/api/v1/conversations", {
      title: "Survivor",
      personaId: "arti", // scan-allow-persona
      providerProfileId: "envkey",
    });
    const zip = Buffer.from(await (await source.raw("/api/v1/backup")).arrayBuffer());

    // Corrupt one byte inside an entry's data region: inspection must refuse
    // (checksum or hash), and nothing may change.
    const poisoned = Buffer.from(zip);
    poisoned[60] = poisoned[60]! ^ 0xff;
    const refused = await source.api("POST", "/api/v1/restore", {
      zipBase64: poisoned.toString("base64"),
      mode: "apply",
      policy: "replace",
    });
    assert.equal(refused.status, 400);

    const conversations = (await source.api("GET", "/api/v1/conversations")).json as {
      conversations: { title: string }[];
    };
    assert.equal(conversations.conversations.length, 1);
    assert.equal(conversations.conversations[0]!.title, "Survivor");
  } finally {
    await source.close();
  }
});

test("phase 6 gate: doctor states and the webhook-conflict diagnosis, online against a fake", async () => {
  // A fake Bot API that reports a registered webhook.
  const bot: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop();
      res.writeHead(200, { "Content-Type": "application/json" });
      if (method === "getMe") {
        res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }));
      } else if (method === "getWebhookInfo") {
        res.end(JSON.stringify({ ok: true, result: { url: "https://example.invalid/hook" } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: [] }));
      }
    });
  });
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  const botOrigin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const h = await harness({ GATE6_KEY: SECRET_VALUE, DELOS_TELEGRAM_BOT_TOKEN: "x" }, botOrigin);
  try {
    // Healthy-ish baseline (telegram disabled): PASS or DEGRADED, never BLOCKED.
    const offline = (await h.api("GET", "/api/v1/doctor")).json as { overall: string };
    assert.notEqual(offline.overall, "BLOCKED");

    // Enable telegram against the fake and ask for the ONLINE probe: the
    // webhook conflict must be diagnosed as BLOCKED, and never repaired.
    await h.api("PUT", "/api/v1/telegram/config", {
      enabled: true,
      tokenSecretId: "telegram:bot",
      tokenEnvVar: "DELOS_TELEGRAM_BOT_TOKEN",
      allowedUserIds: [1001],
      defaultProviderProfileId: "envkey",
      defaultPersonaId: "arti", // scan-allow-persona
      defaultVariants: [],
    });
    const online = (await h.api("GET", "/api/v1/doctor?online=1")).json as {
      overall: string;
      checks: { id: string; status: string; detail: string }[];
    };
    const telegram = online.checks.find((c) => c.id === "telegram")!;
    assert.equal(telegram.status, "BLOCKED");
    assert.match(telegram.detail, /webhook/i);
    assert.equal(online.overall, "BLOCKED");

    // The redacted report endpoint: attachment, and no path/token shapes.
    const report = await h.raw("/api/v1/doctor/report");
    assert.match(report.headers.get("content-disposition") ?? "", /attachment/);
    const text = await report.text();
    assert.ok(!/\/home\/[a-z]/.test(text), "a home path leaked into the report");
    assert.ok(!/\d{5,}:[A-Za-z0-9_-]{20,}/.test(text), "a token shape leaked into the report");
  } finally {
    await h.close();
    await new Promise<void>((resolve) => bot.close(() => resolve()));
  }
});
