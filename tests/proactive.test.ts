/**
 * Proactive decision core (13.2) - injected clocks, injected randomness,
 * every rule proven as arithmetic, never inference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideProactive,
  guardProactiveEcho,
  parseProactiveConfig,
  PROACTIVE_DEFAULTS,
  PROACTIVE_STATE_EMPTY,
  recordProactiveSent,
  recordUserMessage,
  resumeProactive,
  type ProactiveConfig,
  type ProactiveState,
} from "../core/services/proactive.js";

const NOON = "2026-08-02T12:00:00.000Z";
const zeroRandom = () => 0.5; // jitter = 0

function config(overrides: Partial<ProactiveConfig> = {}): ProactiveConfig {
  return {
    ...PROACTIVE_DEFAULTS,
    enabled: true,
    conversationId: "conv-1",
    jitterMinutes: 0,
    policies: { followUpMinutes: 60 },
    ...overrides,
  };
}

function state(overrides: Partial<ProactiveState> = {}): ProactiveState {
  return { ...PROACTIVE_STATE_EMPTY, lastUserMessageAtIso: "2026-08-02T10:00:00.000Z", ...overrides };
}

function tick(c: ProactiveConfig, s: ProactiveState, nowIso = NOON, inFlight = false) {
  return decideProactive({ config: c, state: s, nowIso, userTurnInFlight: inFlight, random: zeroRandom });
}

test("proactive: disabled by default, and off means off", () => {
  const decision = tick({ ...PROACTIVE_DEFAULTS, conversationId: "c" }, state());
  assert.equal(decision.send, false);
  assert.match(decision.reason, /disabled/);
  assert.equal(PROACTIVE_DEFAULTS.enabled, false, "the shipped default must be off");
});

test("proactive: a user turn in flight is never pre-empted", () => {
  const decision = tick(config(), state(), NOON, true);
  assert.equal(decision.send, false);
  assert.match(decision.reason, /never pre-empts/);
});

test("proactive: fires when the jittered threshold has elapsed, with the arithmetic stated", () => {
  const decision = tick(config(), state()); // 120 min since user, threshold 60
  assert.equal(decision.send, true);
  assert.equal(decision.policy, "follow-up");
  assert.match(decision.reason, /120 minutes have elapsed/);
  assert.ok(!/lonely|sad|mood|feel/i.test(decision.reason), "reasons are arithmetic, never inference");
});

test("proactive: below threshold defers and names the earliest eligible time", () => {
  const decision = tick(config({ policies: { followUpMinutes: 180 } }), state());
  assert.equal(decision.send, false);
  assert.ok(decision.notBeforeIso !== undefined);
  assert.equal(decision.notBeforeIso, "2026-08-02T13:00:00.000Z");
});

test("proactive: quiet hours defer regardless of elapsed time", () => {
  const quiet = config({ quietHours: { startHour: 11, endHour: 14, timeZone: "UTC" } });
  const decision = tick(quiet, state());
  assert.equal(decision.send, false);
  assert.match(decision.reason, /quiet hours/i);
  // Wrapping window: 22:00-06:00 does not cover noon.
  const wrapped = config({ quietHours: { startHour: 22, endHour: 6, timeZone: "UTC" } });
  assert.equal(tick(wrapped, state()).send, true);
});

test("proactive: jitter moves the threshold within its band, deterministically per random", () => {
  const jittered = config({ jitterMinutes: 30, policies: { followUpMinutes: 100 } });
  // random=1 -> jitter +30 -> effective 130 > 120 elapsed: defer.
  const high = decideProactive({
    config: jittered, state: state(), nowIso: NOON, userTurnInFlight: false, random: () => 1 - 1e-9,
  });
  assert.equal(high.send, false);
  // random=0 -> jitter -30 -> effective 70 < 120 elapsed: send.
  const low = decideProactive({
    config: jittered, state: state(), nowIso: NOON, userTurnInFlight: false, random: () => 0,
  });
  assert.equal(low.send, true);
});

test("proactive: unanswered sends back off multiplicatively and then pause", () => {
  const c = config({ backoffFactor: 2, pauseAfterUnanswered: 3 });
  let s = state();

  s = recordProactiveSent(s, "first nudge", NOON, c.pauseAfterUnanswered);
  assert.equal(s.unansweredCount, 1);
  assert.equal(s.paused, false);
  // 60 * 2^1 = 120 minutes of backoff: 90 minutes later is too soon.
  const tooSoon = tick(c, s, "2026-08-02T13:30:00.000Z");
  assert.equal(tooSoon.send, false);
  assert.match(tooSoon.reason, /Backing off/);
  assert.equal(tooSoon.notBeforeIso, "2026-08-02T14:00:00.000Z");
  // Past the backoff window it may try again.
  const afterBackoff = tick(c, s, "2026-08-02T14:30:00.000Z");
  assert.equal(afterBackoff.send, true);

  s = recordProactiveSent(s, "second nudge", "2026-08-02T14:30:00.000Z", c.pauseAfterUnanswered);
  s = recordProactiveSent(s, "third nudge", "2026-08-02T20:00:00.000Z", c.pauseAfterUnanswered);
  assert.equal(s.paused, true, "the third unanswered send pauses the runtime");
  const paused = tick(c, s, "2026-08-03T12:00:00.000Z");
  assert.equal(paused.send, false);
  assert.match(paused.reason, /Paused after 3 unanswered/);

  // The user speaking resets everything; manual resume also works.
  const afterUser = recordUserMessage(s, "2026-08-03T13:00:00.000Z");
  assert.equal(afterUser.paused, false);
  assert.equal(afterUser.unansweredCount, 0);
  const resumed = resumeProactive(s);
  assert.equal(resumed.paused, false);
});

test("proactive: the echo guard refuses verbatim and near-duplicate candidates", () => {
  const s = state({
    recentProactiveTexts: ["Thinking of you - how did the presentation go today?"],
  });
  assert.equal(guardProactiveEcho("Thinking of you - how did the presentation go today?", s).ok, false);
  assert.equal(
    guardProactiveEcho("thinking of you! how did the presentation go today", s).ok,
    false,
    "near-duplicates must be refused",
  );
  assert.equal(guardProactiveEcho("Did you end up trying that recipe?", s).ok, true);
});

test("proactive over the daemon: off by default, tick delivers, stored as assistant, echo-guarded", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { startDaemon } = await import("../surfaces/daemon/daemon.js");
  const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas");
  const dataDir = await mkdtemp(join(tmpdir(), "delos-proactive-"));
  let replyCounter = 0;
  const daemon = await startDaemon({
    dataDir,
    shippedPersonaDir: shipped,
    env: {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "served",
        choices: [
          { message: { role: "assistant", content: `Proactive check-in number ${++replyCounter}.` } },
        ],
      }),
    }),
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
    // Off by default: a tick does nothing.
    const idle = await call("POST", "/api/v1/proactive/tick", {});
    assert.equal((idle.json["decision"] as { send: boolean }).send, false);

    const conversation = (
      (await call("POST", "/api/v1/conversations", {
        title: "P",
        personaId: "arti", // scan-allow-persona
        providerProfileId: "local",
      })).json as { conversation: { id: string } }
    ).conversation;
    await call("POST", `/api/v1/conversations/${conversation.id}/messages`, {
      text: "hello there",
      idempotencyKey: "p-1",
    });

    // Enabling needs a target; junk-free config lands on disk.
    const put = await call("PUT", "/api/v1/proactive/config", {
      enabled: true,
      conversationId: conversation.id,
      policies: { followUpMinutes: 30 },
      jitterMinutes: 0,
      pauseAfterUnanswered: 2,
      delivery: { desktop: true, telegram: false },
    });
    assert.equal(put.status, 200);

    // Too soon: deferral names the earliest eligible instant.
    const early = await call("POST", "/api/v1/proactive/tick", { random: 0.5 });
    assert.equal((early.json["decision"] as { send: boolean }).send, false);

    // One hour later (injected clock): the tick sends, stores ONE assistant
    // message, and attributes nothing to the user.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const tick = await call("POST", "/api/v1/proactive/tick", { nowIso: later, random: 0.5 });
    assert.equal((tick.json["decision"] as { send: boolean }).send, true);
    assert.deepEqual(tick.json["delivered"], { desktop: true, telegram: false });

    // The stub answered the ordinary user turn with "number 1", so the
    // proactive tick's own message is "number 2" - exactly one of it.
    const messages = (await call("GET", `/api/v1/conversations/${conversation.id}/messages`)).json as {
      messages: { role: string; text: string }[];
    };
    const proactiveMessages = messages.messages.filter((m) =>
      m.text.startsWith("Proactive check-in number 2"),
    );
    assert.equal(proactiveMessages.length, 1);
    assert.equal(proactiveMessages[0]?.role, "assistant", "proactive text is never user speech");
    const userMessages = messages.messages.filter((m) => m.role === "user");
    assert.equal(userMessages.length, 1, "no user message was fabricated");

    // Immediately after: backoff defers the next attempt.
    const backedOff = await call("POST", "/api/v1/proactive/tick", { nowIso: later, random: 0.5 });
    assert.equal((backedOff.json["decision"] as { send: boolean }).send, false);

    // The state survives on disk and never contains user-authored text.
    const persisted = await readFile(join(dataDir, "proactive.json"), "utf8");
    assert.ok(persisted.includes("Proactive check-in number 2."), "echo window persists proactive text");
    assert.ok(!persisted.includes("hello there"), "user speech never enters proactive state");
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("proactive: config parsing keeps the off default and refuses junk", () => {
  assert.deepEqual(parseProactiveConfig(null), PROACTIVE_DEFAULTS);
  const parsed = parseProactiveConfig({
    enabled: true,
    conversationId: "c1",
    policies: { followUpMinutes: -5, reconnectHours: 24 },
    jitterMinutes: "lots",
    delivery: { telegram: true, desktop: false },
    quietHours: { startHour: 23, endHour: 7, timeZone: "Asia/Shanghai" },
  });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.policies.followUpMinutes, undefined, "a negative threshold is junk");
  assert.equal(parsed.policies.reconnectHours, 24);
  assert.equal(parsed.jitterMinutes, PROACTIVE_DEFAULTS.jitterMinutes);
  assert.deepEqual(parsed.delivery, { desktop: false, telegram: true });
  assert.equal(parsed.quietHours?.startHour, 23);
});
