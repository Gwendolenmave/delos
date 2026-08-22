/**
 * Provider profile schema - synthetic tests.
 *
 * The property under test is that a profile is a NON-SECRET document: anything
 * credential-shaped inside one is refused, and everything else validates
 * strictly enough that a typo fails loudly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  parseProviderProfile,
  parseProviderProfiles,
  ProviderProfileError,
  PROVIDER_KINDS,
} from "../core/domain/provider-profile.js";

const SYNTHETIC_TOKEN = "sk-" + "synthetic-profile-test-token";

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "test-profile",
    kind: "openai-compatible",
    model: "example-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: { transport: "none" },
    ...overrides,
  };
}

function expectFailure(
  document: unknown,
  code: string,
  fieldIncludes?: string,
): ProviderProfileError {
  try {
    parseProviderProfile(document);
  } catch (error) {
    assert.ok(error instanceof ProviderProfileError, `expected ProviderProfileError, got ${error}`);
    assert.equal(error.code, code);
    if (fieldIncludes !== undefined) {
      assert.ok(
        (error.field ?? "").includes(fieldIncludes),
        `field ${error.field} should include ${fieldIncludes}`,
      );
    }
    return error;
  }
  throw new Error(`expected ${code}, but the profile validated`);
}

// --- the four kinds --------------------------------------------------------

test("every provider kind validates under its own rules", () => {
  for (const kind of PROVIDER_KINDS) {
    const document = valid({ kind });
    if (kind === "openai" || kind === "anthropic") {
      delete document["baseUrl"];
      delete document["auth"]; // official kinds default their auth
    }
    if (kind.startsWith("delegated-")) {
      // Delegated kinds talk to a local executable: no endpoint, no
      // credential - the tool owns its own login.
      delete document["baseUrl"];
      delete document["auth"];
    }
    const profile = parseProviderProfile(document);
    assert.equal(profile.kind, kind);
    assert.equal(profile.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(profile.enabled, true);
  }
});

test("compatible kinds require an API root; official kinds refuse one", () => {
  const noUrl = valid();
  delete noUrl["baseUrl"];
  expectFailure(noUrl, "field_invalid", "baseUrl");

  const official = valid({ kind: "openai", auth: { transport: "bearer", secretId: "provider:openai" } });
  delete official["baseUrl"];
  const profile = parseProviderProfile(official);
  assert.equal(profile.baseUrl, undefined);
});

// --- official kinds are a claim the profile cannot make falsely -------------

test("official kinds reject baseUrl: a credential cannot be sent to a chosen host", () => {
  for (const kind of ["openai", "anthropic"]) {
    const document = valid({ kind, baseUrl: "https://relay.example/v1" });
    delete document["auth"];
    const error = expectFailure(document, "field_invalid", "baseUrl");
    assert.ok(error.message.includes(`${kind}-compatible`), "the refusal names the way out");
  }
});

test("official openai permits only bearer transport", () => {
  for (const auth of [
    { transport: "x-api-key", secretId: "provider:openai" },
    { transport: "custom-header", secretId: "provider:openai", headerName: "X-Auth" },
    { transport: "none" },
  ]) {
    const document = valid({ kind: "openai", auth });
    delete document["baseUrl"];
    expectFailure(document, "field_invalid");
  }
});

test("official anthropic permits only x-api-key transport", () => {
  for (const auth of [
    { transport: "bearer", secretId: "provider:anthropic" },
    { transport: "custom-header", secretId: "provider:anthropic", headerName: "X-Auth" },
    { transport: "none" },
  ]) {
    const document = valid({ kind: "anthropic", auth });
    delete document["baseUrl"];
    expectFailure(document, "field_invalid");
  }
});

test("an official profile with no auth block defaults to the conventional variable", () => {
  const openai = valid({ kind: "openai" });
  delete openai["baseUrl"];
  delete openai["auth"];
  const p1 = parseProviderProfile(openai);
  assert.equal(p1.auth.transport, "bearer");
  assert.equal(p1.auth.source, "environment");
  assert.equal(p1.auth.envVar, "OPENAI_API_KEY");

  const anthropic = valid({ kind: "anthropic" });
  delete anthropic["baseUrl"];
  delete anthropic["auth"];
  const p2 = parseProviderProfile(anthropic);
  assert.equal(p2.auth.transport, "x-api-key");
  assert.equal(p2.auth.envVar, "ANTHROPIC_API_KEY");
});

test("compatible kinds retain every transport, including none", () => {
  for (const kind of ["openai-compatible", "anthropic-compatible"]) {
    for (const auth of [
      { transport: "bearer", secretId: "provider:x" },
      { transport: "x-api-key", secretId: "provider:x" },
      { transport: "custom-header", secretId: "provider:x", headerName: "X-Gw" },
      { transport: "none" },
    ]) {
      parseProviderProfile(valid({ kind, auth }));
    }
  }
});

// --- schema and identity ---------------------------------------------------

test("an unsupported schema version is refused, not reinterpreted", () => {
  expectFailure(valid({ schemaVersion: 2 }), "schema_unsupported");
  expectFailure(valid({ schemaVersion: "1" }), "schema_unsupported");
});

test("duplicate profile ids are refused across a set", () => {
  assert.throws(
    () => parseProviderProfiles([valid(), valid({ displayName: "Other" })]),
    (error: unknown) => {
      assert.ok(error instanceof ProviderProfileError);
      assert.equal(error.code, "duplicate_id");
      return true;
    },
  );
});

test("ids are constrained to a stable, path-safe shape", () => {
  for (const bad of ["", "Has Upper", "has space", "-leading", "a/b", "x".repeat(65)]) {
    expectFailure(valid({ id: bad }), "field_invalid", "id");
  }
  parseProviderProfile(valid({ id: "a-1-b" }));
});

test("a blank model is refused", () => {
  expectFailure(valid({ model: "" }), "field_invalid", "model");
  expectFailure(valid({ model: "   " }), "field_invalid", "model");
});

// --- the non-secret property ----------------------------------------------

test("a credential value anywhere in the profile is refused", () => {
  for (const document of [
    valid({ apiKey: SYNTHETIC_TOKEN }),
    valid({ auth: { transport: "bearer", secretId: "provider:x", token: SYNTHETIC_TOKEN } }),
    valid({ nested: { deeper: { access_token: SYNTHETIC_TOKEN } } }),
    valid({ Password: "hunter-" + "2222" }),
  ]) {
    const error = expectFailure(document, "credential_in_profile");
    assert.ok(!error.message.includes(SYNTHETIC_TOKEN), "the refusal must not echo the value");
  }
});

test("secretId is a reference and is explicitly allowed", () => {
  const profile = parseProviderProfile(
    valid({ auth: { transport: "bearer", secretId: "provider:my-relay" } }),
  );
  assert.equal(profile.auth.secretId, "provider:my-relay");
});

test("credentials embedded in the URL are refused", () => {
  expectFailure(
    valid({ baseUrl: "http://user:" + "hunter" + "@127.0.0.1:1234/v1" }),
    "credential_in_profile",
    "baseUrl",
  );
});

test("invalid schemes and malformed URLs are refused", () => {
  expectFailure(valid({ baseUrl: "not a url" }), "url_invalid");
  expectFailure(valid({ baseUrl: "ftp://127.0.0.1/v1" }), "url_invalid");
  expectFailure(valid({ baseUrl: "file:///etc/passwd" }), "url_invalid");
  expectFailure(valid({ baseUrl: "http://127.0.0.1/v1?key=abc" }), "url_invalid");
});

// --- auth shape --------------------------------------------------------------

test("transport none and source none must travel together", () => {
  expectFailure(valid({ auth: { transport: "none", source: "secret-store", secretId: "provider:x" } }), "field_invalid");
  expectFailure(valid({ auth: { transport: "bearer", source: "none" } }), "field_invalid");
});

test("a credential-bearing transport requires a secret reference", () => {
  expectFailure(valid({ auth: { transport: "bearer" } }), "field_invalid", "secretId");
});

test("custom-header transport requires a valid header name", () => {
  expectFailure(
    valid({ auth: { transport: "custom-header", secretId: "provider:x" } }),
    "field_invalid",
    "headerName",
  );
  expectFailure(
    valid({ auth: { transport: "custom-header", secretId: "provider:x", headerName: "Bad Name" } }),
    "header_invalid",
  );
  expectFailure(
    valid({ auth: { transport: "custom-header", secretId: "provider:x", headerName: "Host" } }),
    "header_invalid",
  );
  const profile = parseProviderProfile(
    valid({ auth: { transport: "custom-header", secretId: "provider:x", headerName: "X-Gateway-Auth" } }),
  );
  assert.equal(profile.auth.headerName, "X-Gateway-Auth");
});

// --- extra headers -----------------------------------------------------------

test("framing headers can never be supplied by a profile", () => {
  for (const name of ["Host", "Content-Length", "Connection", "Transfer-Encoding", "te"]) {
    expectFailure(valid({ headers: { [name]: "x" } }), "header_invalid");
  }
});

test("auth headers cannot ride in as ordinary extra headers", () => {
  expectFailure(valid({ headers: { Authorization: "Bearer " + SYNTHETIC_TOKEN } }), "header_invalid");
  expectFailure(valid({ headers: { "x-api-key": SYNTHETIC_TOKEN } }), "header_invalid");
});

test("even with custom-header auth, the credential comes from the store, not headers", () => {
  expectFailure(
    valid({
      auth: { transport: "custom-header", secretId: "provider:x", headerName: "X-Gateway-Auth" },
      headers: { "X-Gateway-Auth": SYNTHETIC_TOKEN },
    }),
    "header_invalid",
  );
});

test("benign non-secret headers survive", () => {
  const profile = parseProviderProfile(
    valid({ headers: { "X-Gateway-Region": "local", "Accept-Language": "en" } }),
  );
  assert.deepEqual(profile.headers, { "X-Gateway-Region": "local", "Accept-Language": "en" });
});

test("header values with control characters are refused", () => {
  const withNewline = "a" + String.fromCharCode(10) + "X-Injected: yes";
  expectFailure(valid({ headers: { "X-Note": withNewline } }), "header_invalid");
  const withCr = "a" + String.fromCharCode(13) + "b";
  expectFailure(valid({ headers: { "X-Note": withCr } }), "header_invalid");
});

// --- timeouts ----------------------------------------------------------------

test("timeouts outside documented bounds are refused", () => {
  expectFailure(valid({ timeoutMs: MIN_TIMEOUT_MS - 1 }), "field_invalid", "timeoutMs");
  expectFailure(valid({ timeoutMs: MAX_TIMEOUT_MS + 1 }), "field_invalid", "timeoutMs");
  expectFailure(valid({ timeoutMs: 1.5 }), "field_invalid", "timeoutMs");
  expectFailure(valid({ timeoutMs: "60000" }), "field_invalid", "timeoutMs");
  assert.equal(parseProviderProfile(valid({ timeoutMs: MIN_TIMEOUT_MS })).timeoutMs, MIN_TIMEOUT_MS);
  assert.equal(parseProviderProfile(valid({ timeoutMs: MAX_TIMEOUT_MS })).timeoutMs, MAX_TIMEOUT_MS);
});

// --- no-auth profile ---------------------------------------------------------

test("a no-auth local profile is first-class, not a workaround", () => {
  const profile = parseProviderProfile(valid());
  assert.equal(profile.auth.transport, "none");
  assert.equal(profile.auth.source, "none");
  assert.equal(profile.auth.secretId, undefined);
});

test("a secretId on a no-auth profile is refused as meaningless", () => {
  expectFailure(
    valid({ auth: { transport: "none", secretId: "provider:x" } }),
    "field_invalid",
    "secretId",
  );
});
