/**
 * Model pinning / no-silent-fallback (B3): a pinned profile accepts a turn
 * only with positive served-model evidence of the requested model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createProviderRegistry } from "../adapters/providers/registry.js";
import { parseProviderProfile } from "../core/domain/provider-profile.js";
import type { SecretStore } from "../core/ports/secret-store.js";
import type { FetchLike } from "../adapters/providers/shared/http-provider-core.js";

const SECRETS: SecretStore = {
  name: "none",
  writable: false,
  has: async () => false,
  get: async () => ({ found: false, reason: "not_configured", detail: "none" }),
};

function chatFetch(servedModel: string | undefined): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ...(servedModel === undefined ? {} : { model: servedModel }),
      choices: [{ message: { role: "assistant", content: "A reply." } }],
    }),
  });
}

function profile(pinModel: boolean) {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "p",
    kind: "openai-compatible",
    model: "wanted-model",
    baseUrl: "http://127.0.0.1:1/v1", // never dialled: fetch is stubbed
    auth: { transport: "none" },
    pinModel,
  });
}

const REQUEST = {
  conversationId: "c",
  turnId: "t",
  systemPrompt: "s",
  messages: [{ role: "user" as const, text: "hi" }],
};

test("pinning: matching served-model evidence passes", async () => {
  const registry = createProviderRegistry({ secretStore: SECRETS, fetchImpl: chatFetch("wanted-model") });
  const turn = await registry.createFromProfile(profile(true)).generate(REQUEST);
  assert.equal(turn.ok, true);
});

test("pinning: a different served model is a model-mismatch failure, never silent", async () => {
  const registry = createProviderRegistry({ secretStore: SECRETS, fetchImpl: chatFetch("cheaper-fallback") });
  const turn = await registry.createFromProfile(profile(true)).generate(REQUEST);
  assert.equal(turn.ok, false);
  if (!turn.ok) {
    assert.equal(turn.error.code, "model-mismatch");
    assert.match(turn.error.message, /pins "wanted-model"/);
    assert.match(turn.error.message, /served "cheaper-fallback"/);
    assert.equal(turn.error.retryable, "no");
  }
});

test("pinning: NO evidence is also a mismatch - silence is not acceptance", async () => {
  const registry = createProviderRegistry({ secretStore: SECRETS, fetchImpl: chatFetch(undefined) });
  const turn = await registry.createFromProfile(profile(true)).generate(REQUEST);
  assert.equal(turn.ok, false);
  if (!turn.ok) {
    assert.equal(turn.error.code, "model-mismatch");
    assert.match(turn.error.message, /no served-model evidence/);
  }
});

test("pinning: an unpinned profile records evidence but accepts the reply", async () => {
  const registry = createProviderRegistry({ secretStore: SECRETS, fetchImpl: chatFetch("cheaper-fallback") });
  const turn = await registry.createFromProfile(profile(false)).generate(REQUEST);
  assert.equal(turn.ok, true);
  if (turn.ok) assert.equal(turn.result.servedModel, "cheaper-fallback");
});

test("pinning: pinModel must be a boolean and defaults to off", () => {
  assert.throws(
    () =>
      parseProviderProfile({
        schemaVersion: 1,
        id: "p",
        kind: "openai-compatible",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { transport: "none" },
        pinModel: "yes",
      }),
    /pinModel must be a boolean/,
  );
  const parsed = profile(false);
  assert.equal(parsed.pinModel, undefined, "off is the absent default, not a stored false");
});
