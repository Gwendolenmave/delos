/**
 * Daemon - security gate and API behaviour over real HTTP on loopback.
 *
 * Providers are stub fetch implementations injected through the daemon's
 * fetchImpl; no external host is contacted, every credential is synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDaemon, type RunningDaemon } from "../surfaces/daemon/daemon.js";
import type { FetchLike } from "../adapters/providers/shared/http-provider-core.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");

const chatBody = (text: string) => ({
  model: "served-model",
  choices: [{ message: { role: "assistant", content: text } }],
});

function stubProvider(): FetchLike {
  let n = 0;
  return async () => {
    n++;
    return { ok: true, status: 200, json: async () => chatBody(`Reply ${n}.`) };
  };
}

const SEED_PROFILE = {
  schemaVersion: 1,
  id: "local",
  kind: "openai-compatible",
  model: "local-model",
  baseUrl: "http://127.0.0.1:1/v1", // never dialled: fetch is stubbed
  auth: { transport: "none" },
};

interface Harness {
  daemon: RunningDaemon;
  dataDir: string;
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;
  close: () => Promise<void>;
}

async function harness(fetchImpl: FetchLike = stubProvider()): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-daemon-"));
  const daemon = await startDaemon({
    dataDir,
    shippedPersonaDir: SHIPPED,
    env: {},
    seedProfiles: [SEED_PROFILE],
    fetchImpl,
  });
  const api = async (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await fetch(`${daemon.origin}${path}`, {
      method,
      headers: {
        "x-delos-session": daemon.sessionToken,
        origin: daemon.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined };
  };
  return {
    daemon,
    dataDir,
    api,
    close: async () => {
      await daemon.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

// --- security gate -----------------------------------------------------------

test("daemon: no session header means 401, wrong token means 401", async () => {
  const h = await harness();
  try {
    const bare = await fetch(`${h.daemon.origin}/api/v1/health`);
    assert.equal(bare.status, 401);
    const wrong = await fetch(`${h.daemon.origin}/api/v1/health`, {
      headers: { "x-delos-session": "not-the-token" },
    });
    assert.equal(wrong.status, 401);
  } finally {
    await h.close();
  }
});

test("daemon: a foreign origin is refused even WITH a valid token", async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.daemon.origin}/api/v1/health`, {
      headers: { "x-delos-session": h.daemon.sessionToken, origin: "http://evil.example" },
    });
    assert.equal(response.status, 403, "a hostile page with a stolen token still fails");
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "foreign_origin");
  } finally {
    await h.close();
  }
});

test("daemon: the token travels in a header, never a query parameter", async () => {
  const h = await harness();
  try {
    const response = await fetch(
      `${h.daemon.origin}/api/v1/health?session=${h.daemon.sessionToken}&x-delos-session=${h.daemon.sessionToken}`,
    );
    assert.equal(response.status, 401, "a query-string credential was honoured");
  } finally {
    await h.close();
  }
});

test("daemon: bodies over the cap are refused; errors have one public shape", async () => {
  const h = await harness();
  try {
    const big = await h.api("POST", "/api/v1/situations", { text: "x".repeat(1_100_000), expiresAtIso: "2030-01-01T00:00:00Z" });
    assert.equal(big.status, 413);
    const unknown = await h.api("GET", "/api/v1/definitely-not-a-route");
    assert.equal(unknown.status, 404);
    for (const result of [big, unknown]) {
      const error = (result.json as { error: { code: string; message: string } }).error;
      assert.equal(typeof error.code, "string");
      assert.equal(typeof error.message, "string");
      assert.ok(!error.message.includes("    at "), "a stack trace leaked");
    }
  } finally {
    await h.close();
  }
});

test("daemon: binds loopback and refuses any other host", async () => {
  await assert.rejects(() =>
    startDaemon({ dataDir: "/tmp/never", shippedPersonaDir: SHIPPED, env: {}, host: "0.0.0.0" }),
  );
});

// --- health, schema, settings ------------------------------------------------

test("daemon: health, schema, settings and diagnostics answer safely", async () => {
  const h = await harness();
  try {
    const health = await h.api("GET", "/api/v1/health");
    assert.equal(health.status, 200);
    assert.equal((health.json as { apiVersion: number }).apiVersion, 1);

    const schema = await h.api("GET", "/api/v1/schema");
    const routes = (schema.json as { routes: { path: string }[] }).routes;
    assert.ok(routes.length >= 30, "the schema names the API surface");

    const diagnostics = await h.api("GET", "/api/v1/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.ok(!JSON.stringify(diagnostics.json).includes("sk-"), "diagnostics leaked a credential shape");

    // Telegram: unconfigured out of the box, disabled by default, and the
    // config echo carries references only - never a token shape.
    const telegram = await h.api("GET", "/api/v1/telegram/status");
    const telegramStatus = telegram.json as {
      configured: boolean;
      enabled: boolean;
      running: boolean;
      config: { tokenSecretId: string };
    };
    assert.equal(telegramStatus.configured, false);
    assert.equal(telegramStatus.enabled, false);
    assert.equal(telegramStatus.running, false);
    assert.equal(telegramStatus.config.tokenSecretId, "telegram:bot");

    // A pasted token is refused before it can reach the settings file. The
    // token-shaped fixture is assembled from fragments so no source line
    // carries the shape the scanner hunts.
    const pasted = await h.api("PUT", "/api/v1/telegram/config", {
      enabled: false,
      tokenSecretId: ["1234567", "AAFakeTokenShapedValue-abcdefghijk"].join(":"),
      allowedUserIds: [1],
      defaultProviderProfileId: "p",
      defaultPersonaId: "arti", // scan-allow-persona
      defaultVariants: [],
    });
    assert.equal(pasted.status, 400);
    assert.match(
      ((pasted.json as { error: { message: string } }).error ?? { message: "" }).message,
      /looks like a bot token/,
    );

    // Starting while unconfigured is a clear 400, not a crash.
    const start = await h.api("POST", "/api/v1/telegram/start");
    assert.equal(start.status, 400);
  } finally {
    await h.close();
  }
});

test("daemon: delegated status detects the configured executables honestly", async () => {
  const h = await harness();
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "delegated");
  try {
    // Deterministic detection: profiles point at the committed fakes, so this
    // test never depends on what is installed on the machine running it.
    for (const [id, kind, file] of [
      ["dcx", "delegated-codex", "fake-codex.mjs"],
      ["dcc", "delegated-claude-code", "fake-claude.mjs"],
    ] as const) {
      const created = await h.api("POST", "/api/v1/providers", {
        schemaVersion: 1,
        id,
        kind,
        model: "advisory-model",
        executablePath: join(fixtures, file),
      });
      assert.equal(created.status, 201, `the ${kind} profile was refused`);
    }

    const status = await h.api("GET", "/api/v1/delegated/status");
    assert.equal(status.status, 200);
    const body = status.json as {
      codex: { installed: boolean; version?: string; authState: string; note: string };
      claudeCode: { installed: boolean; version?: string; authState: string; note: string };
    };
    assert.equal(body.codex.installed, true);
    assert.match(body.codex.version ?? "", /9\.9\.9-fake/);
    assert.equal(body.claudeCode.installed, true);
    // Auth state belongs to the tool's OFFICIAL surface, inspected at turn
    // time - never its credential files, and never probed by this endpoint.
    assert.equal(body.codex.authState, "inspected-per-turn");
    assert.match(body.codex.note, /owns its own login/);
    assert.match(body.codex.note, /official surface/);
    assert.ok(!JSON.stringify(body).includes("@"), "no account identifier appears in the status");
  } finally {
    await h.close();
  }
});

// --- providers ---------------------------------------------------------------

test("daemon: provider CRUD round-trips and the connection test uses the real path", async () => {
  const h = await harness();
  try {
    const list = await h.api("GET", "/api/v1/providers");
    assert.equal((list.json as { profiles: unknown[] }).profiles.length, 1);

    const created = await h.api("POST", "/api/v1/providers", {
      schemaVersion: 1,
      id: "second",
      kind: "openai-compatible",
      model: "m2",
      baseUrl: "http://127.0.0.1:1/v1",
      auth: { transport: "none" },
    });
    assert.equal(created.status, 201);

    const probe = await h.api("POST", "/api/v1/providers/local/test");
    assert.equal(probe.status, 200);
    assert.equal((probe.json as { servedModel: string }).servedModel, "served-model");

    const withSecret = await h.api("POST", "/api/v1/providers", {
      schemaVersion: 1,
      id: "leaky",
      kind: "openai-compatible",
      model: "m",
      baseUrl: "http://127.0.0.1:1/v1",
      auth: { transport: "none" },
      apiKey: "sk-" + "synthetic-inline-key",
    });
    assert.equal(withSecret.status, 500, "a credential-bearing profile was accepted");

    const removed = await h.api("DELETE", "/api/v1/providers/second");
    assert.equal(removed.status, 200);
  } finally {
    await h.close();
  }
});

// --- personas ----------------------------------------------------------------

test("daemon: persona list, wizard create, duplicate, export, delete", async () => {
  const h = await harness();
  try {
    const list = await h.api("GET", "/api/v1/personas");
    const personas = (list.json as { personas: { id: string; shipped: boolean }[] }).personas;
    assert.ok(personas.some((p) => p.id === "arti" && p.shipped)); // scan-allow-persona

    const created = await h.api("POST", "/api/v1/personas", {
      mode: "wizard",
      wizard: { id: "my-own", identity: "You are a daemon-created persona." },
    });
    assert.equal(created.status, 201);

    const duplicate = await h.api("POST", "/api/v1/personas/arti/duplicate", { newId: "arti-copy" }); // scan-allow-persona
    assert.equal(duplicate.status, 201);

    const conflict = await h.api("POST", "/api/v1/personas", {
      mode: "wizard",
      wizard: { id: "arti", identity: "impostor" }, // scan-allow-persona
    });
    assert.equal(conflict.status, 409, "a shipped id was overwritten");

    const shippedDelete = await h.api("DELETE", "/api/v1/personas/arti"); // scan-allow-persona
    assert.equal(shippedDelete.status, 400, "a shipped persona was deleted");

    const userDelete = await h.api("DELETE", "/api/v1/personas/arti-copy"); // scan-allow-persona
    assert.equal(userDelete.status, 200);

    const exported = await fetch(`${h.daemon.origin}/api/v1/personas/my-own/export`, {
      headers: { "x-delos-session": h.daemon.sessionToken, origin: h.daemon.origin },
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/zip");
  } finally {
    await h.close();
  }
});

// --- conversations, messages, SSE, idempotency -------------------------------

test("daemon: a conversation round-trip with SSE events and idempotent send", async () => {
  const h = await harness();
  try {
    const conversation = await h.api("POST", "/api/v1/conversations", {
      title: "First",
      personaId: "arti", // scan-allow-persona
      providerProfileId: "local",
    });
    assert.equal(conversation.status, 201);
    const id = (conversation.json as { conversation: { id: string } }).conversation.id;

    // SSE listener
    const events: string[] = [];
    const sse = await fetch(`${h.daemon.origin}/api/v1/conversations/${id}/events`, {
      headers: { "x-delos-session": h.daemon.sessionToken, origin: h.daemon.origin },
    });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    const readLoop = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (line.startsWith("event: ")) events.push(line.slice(7).trim());
        }
      }
    })().catch(() => undefined);

    const send = await h.api("POST", `/api/v1/conversations/${id}/messages`, {
      text: "Hello daemon.",
      idempotencyKey: "turn-1",
    });
    assert.equal(send.status, 200);
    const outcome = (send.json as { outcome: { kind: string; assistantText: string; reused: boolean } }).outcome;
    assert.equal(outcome.kind, "completed");
    assert.equal(outcome.assistantText, "Reply 1.");

    // idempotent resend: stored result, model untouched (reply number pinned)
    const resend = await h.api("POST", `/api/v1/conversations/${id}/messages`, {
      text: "Hello daemon.",
      idempotencyKey: "turn-1",
    });
    const reOutcome = (resend.json as { outcome: { assistantText: string; reused: boolean } }).outcome;
    assert.equal(reOutcome.assistantText, "Reply 1.", "a duplicate regenerated");
    assert.equal(reOutcome.reused, true);

    // second real turn carries history
    const second = await h.api("POST", `/api/v1/conversations/${id}/messages`, {
      text: "And again.",
      idempotencyKey: "turn-2",
    });
    assert.equal((second.json as { outcome: { assistantText: string } }).outcome.assistantText, "Reply 2.");

    const messages = await h.api("GET", `/api/v1/conversations/${id}/messages`);
    assert.equal((messages.json as { messages: unknown[] }).messages.length, 4);

    // history query through the API
    const history = await h.api("POST", `/api/v1/conversations/${id}/history-query`, {
      query: { kind: "keyword", literal: "hello", around: 0 },
    });
    assert.equal((history.json as { records: unknown[]; read: boolean }).read, true);
    assert.ok((history.json as { records: unknown[] }).records.length >= 1);

    await reader.cancel().catch(() => undefined);
    assert.ok(events.includes("turn-accepted"), `events were ${events.join(",")}`);
    assert.ok(events.includes("assistant-text"), "the buffered assistant event never arrived");

    const cancel = await h.api("POST", `/api/v1/conversations/${id}/cancel`);
    assert.equal(cancel.status, 501, "cancellation must be honestly unsupported, not faked");
  } finally {
    await h.close();
  }
});

// --- situations and backup ---------------------------------------------------

test("daemon: situations CRUD persists across a daemon restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-daemon-"));
  try {
    const first = await startDaemon({
      dataDir,
      shippedPersonaDir: SHIPPED,
      env: {},
      seedProfiles: [SEED_PROFILE],
      fetchImpl: stubProvider(),
    });
    const create = await fetch(`${first.origin}/api/v1/situations`, {
      method: "POST",
      headers: {
        "x-delos-session": first.sessionToken,
        origin: first.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Travelling until Friday.", expiresAtIso: "2030-01-01T00:00:00.000Z" }),
    });
    assert.equal(create.status, 201);
    await first.close();

    const second = await startDaemon({
      dataDir,
      shippedPersonaDir: SHIPPED,
      env: {},
      fetchImpl: stubProvider(),
    });
    const listed = await fetch(`${second.origin}/api/v1/situations`, {
      headers: { "x-delos-session": second.sessionToken, origin: second.origin },
    });
    const body = (await listed.json()) as { active: { text: string }[] };
    assert.equal(body.active[0]?.text, "Travelling until Friday.");
    await second.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("daemon: backup is a zip carrying situations and profiles; no secrets", async () => {
  const h = await harness();
  try {
    await h.api("POST", "/api/v1/situations", { text: "In transit.", expiresAtIso: "2030-01-01T00:00:00.000Z" });
    const response = await fetch(`${h.daemon.origin}/api/v1/backup`, {
      headers: { "x-delos-session": h.daemon.sessionToken, origin: h.daemon.origin },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/zip/);
    // Entries are stored uncompressed in the deterministic archive, so the
    // content is directly inspectable as bytes.
    const text = Buffer.from(await response.arrayBuffer()).toString("latin1");
    assert.ok(text.includes("In transit."));
    assert.ok(text.includes("backup.json"), "the manifest entry is present");
    assert.ok(!/sk-[A-Za-z0-9]/.test(text), "a credential shape appears in the backup");
  } finally {
    await h.close();
  }
});
