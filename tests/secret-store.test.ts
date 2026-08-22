/**
 * SecretStore - synthetic tests.
 *
 * Every credential here is assembled from fragments so this file contains no
 * literal that looks like a real token, and no test reads the real process
 * environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertValidSecretId,
  isValidSecretId,
  SecretStoreError,
} from "../core/ports/secret-store.js";
import {
  createEnvironmentSecretStore,
  DEFAULT_ENVIRONMENT_MAPPING,
  OPENAI_SECRET_ID,
  ANTHROPIC_SECRET_ID,
} from "../adapters/secret-store/environment/environment-secret-store.js";
import { createInMemorySecretStore } from "../adapters/secret-store/memory/in-memory-secret-store.js";

const VALUE = "sk-" + "synthetic-secret-store-value";
const OTHER = "synthetic-" + "relay-token-value";

// --- secret ids ------------------------------------------------------------

test("secret ids are namespaced references, not free text", () => {
  for (const good of ["provider:openai", "provider:my-relay", "a", "x.y-z:1", "env:OPENAI_API_KEY"]) {
    assert.ok(isValidSecretId(good), `${good} should be valid`);
  }
  for (const bad of ["", " ", "has space", "trailing:", ":leading", "a/b", "a\nb", "x".repeat(129)]) {
    assert.ok(!isValidSecretId(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

test("an invalid secret id is refused with its own error code", () => {
  assert.throws(
    () => assertValidSecretId("not a reference"),
    (error: unknown) => {
      assert.ok(error instanceof SecretStoreError);
      assert.equal(error.code, "invalid_secret_id");
      return true;
    },
  );
});

// --- environment store -----------------------------------------------------

test("the environment store resolves exactly the mapped variable", async () => {
  const store = createEnvironmentSecretStore({
    env: { MY_TOKEN: VALUE, UNRELATED: "must not be read" },
    mapping: { "provider:mine": "MY_TOKEN" },
  });

  const found = await store.get("provider:mine");
  assert.equal(found.found, true);
  if (found.found) assert.equal(found.value, VALUE);
  assert.equal(await store.has("provider:mine"), true);
});

test("the default mapping covers the two official providers", async () => {
  const store = createEnvironmentSecretStore({
    env: { OPENAI_API_KEY: VALUE, ANTHROPIC_API_KEY: OTHER },
    mapping: DEFAULT_ENVIRONMENT_MAPPING,
  });
  const openai = await store.get(OPENAI_SECRET_ID);
  const anthropic = await store.get(ANTHROPIC_SECRET_ID);
  assert.equal(openai.found && openai.value, VALUE);
  assert.equal(anthropic.found && anthropic.value, OTHER);
});

test("a user-defined mapping works for a compatible provider", async () => {
  const store = createEnvironmentSecretStore({
    env: { RELAY_TOKEN_A: OTHER },
    mapping: { "provider:relay-a": "RELAY_TOKEN_A" },
  });
  const got = await store.get("provider:relay-a");
  assert.equal(got.found && got.value, OTHER);
});

test("an unmapped reference is not_configured, not a crash", async () => {
  const store = createEnvironmentSecretStore({ env: {}, mapping: {} });
  const got = await store.get("provider:absent");
  assert.equal(got.found, false);
  if (!got.found) {
    assert.equal(got.reason, "not_configured");
    assert.ok(got.detail.includes("provider:absent"));
  }
});

test("a mapped but unset variable names the variable, not the reference only", async () => {
  const store = createEnvironmentSecretStore({
    env: {},
    mapping: { "provider:mine": "MY_TOKEN" },
  });
  const got = await store.get("provider:mine");
  assert.equal(got.found, false);
  if (!got.found) {
    assert.equal(got.reason, "not_configured");
    assert.ok(got.detail.includes("MY_TOKEN"), "the user needs the variable name");
  }
});

test("an empty variable is unavailable, not missing", async () => {
  // The user DID set it. Telling them it is missing sends them to fix the
  // wrong thing.
  for (const empty of ["", "   ", "\n"]) {
    const store = createEnvironmentSecretStore({
      env: { MY_TOKEN: empty },
      mapping: { "provider:mine": "MY_TOKEN" },
    });
    const got = await store.get("provider:mine");
    assert.equal(got.found, false);
    if (!got.found) assert.equal(got.reason, "unavailable");
    assert.equal(await store.has("provider:mine"), false);
  }
});

test("an opaque token is never trimmed or transformed", async () => {
  // We do not get to have opinions about a credential's format. A token with
  // meaningful surrounding characters must survive byte for byte.
  const padded = `  ${VALUE}\t`;
  const store = createEnvironmentSecretStore({
    env: { MY_TOKEN: padded },
    mapping: { "provider:mine": "MY_TOKEN" },
  });
  const got = await store.get("provider:mine");
  assert.equal(got.found && got.value, padded);
});

test("the environment store is read-only and says so", async () => {
  const store = createEnvironmentSecretStore({ env: {}, mapping: {} });
  assert.equal(store.writable, false);
  assert.equal(store.set, undefined, "a set() that did nothing would be worse than none");
  assert.equal(store.delete, undefined);
});

test("the environment is never enumerated", async () => {
  // A proxy that throws on ownKeys: any attempt to walk the environment fails
  // the test rather than quietly succeeding.
  const readKeys: string[] = [];
  const env = new Proxy({ MY_TOKEN: VALUE, SECRET_OTHER: OTHER } as Record<string, string>, {
    get(target, key: string) {
      readKeys.push(key);
      return target[key];
    },
    ownKeys() {
      throw new Error("the environment must not be enumerated");
    },
  });
  const store = createEnvironmentSecretStore({
    env,
    mapping: { "provider:mine": "MY_TOKEN" },
  });
  await store.get("provider:mine");
  await store.has("provider:mine");
  assert.deepEqual(readKeys, ["MY_TOKEN", "MY_TOKEN"], "only the mapped variable may be read");

  // listIds reports the configured mapping, never what happens to be set.
  assert.deepEqual(await store.listIds?.(), ["provider:mine"]);
});

test("an unusable environment variable name is refused at construction", () => {
  assert.throws(
    () => createEnvironmentSecretStore({ env: {}, mapping: { "provider:x": "not a name" } }),
    SecretStoreError,
  );
});

// --- in-memory store -------------------------------------------------------

test("the in-memory store sets, replaces and deletes", async () => {
  const store = createInMemorySecretStore();
  assert.equal(store.writable, true);
  assert.equal(await store.has("provider:mine"), false);

  await store.set?.("provider:mine", VALUE);
  const first = await store.get("provider:mine");
  assert.equal(first.found && first.value, VALUE);

  await store.set?.("provider:mine", OTHER);
  const second = await store.get("provider:mine");
  assert.equal(second.found && second.value, OTHER, "setting twice rotates");

  await store.delete?.("provider:mine");
  assert.equal(await store.has("provider:mine"), false);
});

test("deleting an absent credential is success, not an error", async () => {
  const store = createInMemorySecretStore();
  await store.delete?.("provider:never-existed");
  assert.ok(true);
});

test("an empty credential is refused rather than stored", async () => {
  const store = createInMemorySecretStore();
  await assert.rejects(() => store.set?.("provider:mine", "") as Promise<void>, SecretStoreError);
  assert.throws(
    () => createInMemorySecretStore({ initial: { "provider:mine": "" } }),
    SecretStoreError,
  );
});

test("the in-memory store lists ids and never values", async () => {
  const store = createInMemorySecretStore({
    initial: { "provider:b": VALUE, "provider:a": OTHER },
  });
  const ids = await store.listIds?.();
  assert.deepEqual(ids, ["provider:a", "provider:b"]);
  assert.ok(!JSON.stringify(ids).includes(VALUE));
  assert.ok(!JSON.stringify(ids).includes(OTHER));
});

test("no store exposes a method that returns every plaintext value", () => {
  for (const store of [
    createInMemorySecretStore({ initial: { "provider:mine": VALUE } }),
    createEnvironmentSecretStore({ env: { A: VALUE }, mapping: { "provider:mine": "A" } }),
  ]) {
    const surface = Object.keys(store);
    for (const forbidden of ["entries", "values", "dump", "all", "export"]) {
      assert.ok(!surface.includes(forbidden), `${store.name} exposes ${forbidden}`);
    }
  }
});
