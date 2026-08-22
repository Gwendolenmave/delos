/**
 * runtime-config - synthetic tests.
 *
 * Every configuration is written into a fresh temporary directory. No value
 * here resembles a real endpoint or a real credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

import {
  loadRuntimeConfig,
  RuntimeConfigError,
  DEFAULT_TIMEOUT_MS,
} from "../adapters/config/filesystem/runtime-config.js";

/** A synthetic value that must never appear in an error message. */
const SYNTHETIC_ENV_NAME = "DELOS_TEST_MODEL_KEY";

const MINIMAL = {
  schemaVersion: 1,
  promptRoot: "./prompts",
  provider: {
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "example-model",
  },
  recentWindow: { maxEstimatedTokens: 8000 },
};

async function withConfig(
  document: unknown,
  fileName = "delos.config.json",
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "delos-config-test-"));
  const path = join(dir, fileName);
  const text = typeof document === "string" ? document : JSON.stringify(document, null, 2);
  await writeFile(path, text, "utf8");
  return { dir, path };
}

async function expectFailure(
  path: string,
  kind: string,
): Promise<RuntimeConfigError> {
  try {
    await loadRuntimeConfig({ configPath: path });
  } catch (error) {
    assert.ok(error instanceof RuntimeConfigError, `expected RuntimeConfigError, got ${error}`);
    assert.equal(error.kind, kind);
    return error;
  }
  throw new Error(`expected a ${kind} failure, but loading succeeded`);
}

// --- valid documents -------------------------------------------------------

test("a minimal configuration loads with documented defaults", async () => {
  const { dir, path } = await withConfig(MINIMAL);
  const config = await loadRuntimeConfig({ configPath: path });

  assert.equal(config.schemaVersion, 1);
  assert.equal(config.provider.kind, "openai-compatible");
  assert.equal(config.provider.model, "example-model");
  assert.equal(config.provider.apiKeyEnv, undefined);
  assert.equal(config.provider.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.recentWindow.maxEstimatedTokens, 8000);
  assert.equal(config.recentWindow.reserveTokens, 0);
  await rm(dir, { recursive: true, force: true });
});

test("every optional field is accepted when present", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: {
      ...MINIMAL.provider,
      apiKeyEnv: SYNTHETIC_ENV_NAME,
      timeoutMs: 15_000,
    },
    recentWindow: { maxEstimatedTokens: 4000, reserveTokens: 500 },
  });
  const config = await loadRuntimeConfig({ configPath: path });

  assert.equal(config.provider.apiKeyEnv, SYNTHETIC_ENV_NAME);
  assert.equal(config.provider.timeoutMs, 15_000);
  assert.equal(config.recentWindow.reserveTokens, 500);
  await rm(dir, { recursive: true, force: true });
});

test("a relative prompt root resolves against the config directory", async () => {
  // Not against the process working directory: the same file must mean the
  // same thing wherever the command is run from.
  const { dir, path } = await withConfig(MINIMAL);
  const config = await loadRuntimeConfig({ configPath: path });

  assert.ok(isAbsolute(config.promptRoot));
  assert.equal(config.promptRoot, join(dir, "prompts"));
  await rm(dir, { recursive: true, force: true });
});

test("an absolute prompt root is left absolute", async () => {
  const absolute = join(tmpdir(), "delos-elsewhere", "prompts");
  const { dir, path } = await withConfig({ ...MINIMAL, promptRoot: absolute });
  const config = await loadRuntimeConfig({ configPath: path });

  assert.equal(config.promptRoot, absolute);
  await rm(dir, { recursive: true, force: true });
});

test("a byte-order mark before valid JSON is tolerated", async () => {
  const { dir, path } = await withConfig("﻿" + JSON.stringify(MINIMAL));
  const config = await loadRuntimeConfig({ configPath: path });
  assert.equal(config.provider.model, "example-model");
  await rm(dir, { recursive: true, force: true });
});

test("a symlinked configuration path is followed, by contract", async () => {
  const { dir, path } = await withConfig(MINIMAL);
  const linkDir = await mkdtemp(join(tmpdir(), "delos-config-link-"));
  const link = join(linkDir, "linked.config.json");
  await symlink(path, link);

  const config = await loadRuntimeConfig({ configPath: link });
  assert.equal(config.provider.model, "example-model");
  await rm(dir, { recursive: true, force: true });
  await rm(linkDir, { recursive: true, force: true });
});

// --- file-level failures ---------------------------------------------------

test("a missing file is distinguished from an unreadable one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-config-test-"));
  await expectFailure(join(dir, "absent.json"), "config_file_missing");
  await rm(dir, { recursive: true, force: true });
});

test("a directory given as the config path is a typed failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-config-test-"));
  await mkdir(join(dir, "notafile"));
  await expectFailure(join(dir, "notafile"), "config_path_not_a_file");
  await rm(dir, { recursive: true, force: true });
});

test("invalid UTF-8 is a typed failure, not replacement characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-config-test-"));
  const path = join(dir, "bad.json");
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
  await expectFailure(path, "config_invalid_utf8");
  await rm(dir, { recursive: true, force: true });
});

test("malformed JSON is a typed failure", async () => {
  const { dir, path } = await withConfig("{ not json");
  await expectFailure(path, "config_invalid_json");
  await rm(dir, { recursive: true, force: true });
});

// --- a malformed document must not come back out ---------------------------
//
// `JSON.parse` describes a fault by quoting the source around it. On the
// runtime this was written against it quotes roughly ten characters, or the
// whole document when the document is short. A value mistakenly written into
// the configuration - the exact mistake a user makes when they paste a key
// into a file instead of into an environment variable - therefore sits in the
// parser's message. So the parser's message is never used.
//
// A ten-character prefix is still a leak: it is enough to identify a key and
// often which service issued it. The assertions below check the prefix, not
// just the whole value.

/** Key-shaped on purpose. Assembled from fragments so it is not a literal. */
const PLANTED = "sk-" + "planted-value-must-not-leak";
const PLANTED_PREFIX = PLANTED.slice(0, 10);

/**
 * The only shape the message may take: a fixed phrase, an optional location
 * made of digits, and the path the user gave. Nothing derived from the
 * document can pass this.
 */
function assertSafeJsonMessage(message: string, path: string): void {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = new RegExp(
    `^Configuration file is not valid JSON` +
      `(?: \\((?:line \\d+, column \\d+|at character \\d+)\\))?` +
      `: ${escaped}$`,
  );
  assert.match(message, shape);
}

test("a malformed document is never echoed back in the error", async () => {
  // Written UNQUOTED so the parser faults exactly on the planted value, which
  // is where the runtime quotes surrounding source.
  const documents = [
    `{"apiKeyEnv": ${PLANTED}}`,
    `{\n  "schemaVersion": 1,\n  "promptRoot": "./p",\n  "note": ${PLANTED}\n}`,
    `${PLANTED}`,
    `{"schemaVersion": 1, "x": "${PLANTED}",}`,
    `{"schemaVersion": 1, "x": "${PLANTED}"`,
  ];

  for (const document of documents) {
    const { dir, path } = await withConfig(document);
    const error = await expectFailure(path, "config_invalid_json");

    assert.ok(!error.message.includes(PLANTED), `the value leaked: ${error.message}`);
    assert.ok(
      !error.message.includes(PLANTED_PREFIX),
      `a prefix of the value leaked: ${error.message}`,
    );
    assertSafeJsonMessage(error.message, path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a useful location survives, made only of digits", async () => {
  const { dir, path } = await withConfig(`{\n  "schemaVersion": 1,\n  "oops"\n}`);
  const error = await expectFailure(path, "config_invalid_json");

  assertSafeJsonMessage(error.message, path);
  // The fault is on the third line, so the user is told where to look rather
  // than only that the file is wrong somewhere.
  assert.match(error.message, /\(line \d+, column \d+\)/);
  await rm(dir, { recursive: true, force: true });
});

test("no property name from the document reaches the message either", async () => {
  const { dir, path } = await withConfig(`{"UNUSUAL_PROPERTY_NAME_HERE" 1}`);
  const error = await expectFailure(path, "config_invalid_json");
  assert.ok(!error.message.includes("UNUSUAL_PROPERTY_NAME_HERE"));
  assertSafeJsonMessage(error.message, path);
  await rm(dir, { recursive: true, force: true });
});

// --- schema failures -------------------------------------------------------

test("an unsupported schema version is refused, not reinterpreted", async () => {
  const { dir, path } = await withConfig({ ...MINIMAL, schemaVersion: 2 });
  const error = await expectFailure(path, "config_unsupported_version");
  assert.equal(error.field, "schemaVersion");
  await rm(dir, { recursive: true, force: true });
});

test("a missing required field names the field", async () => {
  const provider = { ...MINIMAL.provider } as Record<string, unknown>;
  delete provider["model"];
  const { dir, path } = await withConfig({ ...MINIMAL, provider });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.model");
  await rm(dir, { recursive: true, force: true });
});

test("an unknown root field is refused", async () => {
  const { dir, path } = await withConfig({ ...MINIMAL, memoryBackend: "sqlite" });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "memoryBackend");
  await rm(dir, { recursive: true, force: true });
});

test("an unknown provider field is refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, temperature: 0.7 },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.temperature");
  await rm(dir, { recursive: true, force: true });
});

test("an unknown recent-window field is refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    recentWindow: { maxEstimatedTokens: 100, hardRetain: 20 },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "recentWindow.hardRetain");
  await rm(dir, { recursive: true, force: true });
});

test("a raw credential field is refused as unknown, never stored", async () => {
  // The configuration format has no place to put a secret, by construction.
  const plantedValue = "sk-" + "synthetic-value-not-real";
  for (const field of ["apiKey", "token", "password", "secret"]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, [field]: plantedValue },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, `provider.${field}`);
    assert.ok(
      !error.message.includes(plantedValue),
      `${field}: the rejected value appeared in the error`,
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty model is refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, model: "   " },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.model");
  await rm(dir, { recursive: true, force: true });
});

test("the configured model text is preserved exactly", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, model: "vendor/model-name:v2" },
  });
  const config = await loadRuntimeConfig({ configPath: path });
  assert.equal(config.provider.model, "vendor/model-name:v2");
  await rm(dir, { recursive: true, force: true });
});

// --- base URL --------------------------------------------------------------

test("a malformed base URL is refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, baseUrl: "not a url" },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.baseUrl");
  await rm(dir, { recursive: true, force: true });
});

test("credentials embedded in the base URL are refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: {
      ...MINIMAL.provider,
      baseUrl: "https://user:" + "synthetic" + "@example.invalid/v1",
    },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.baseUrl");
  assert.ok(!error.message.includes("synthetic"));
  await rm(dir, { recursive: true, force: true });
});

test("a query string or fragment in the base URL is refused", async () => {
  for (const url of [
    "https://example.invalid/v1?key=abc",
    "https://example.invalid/v1#frag",
  ]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, "provider.baseUrl");
    await rm(dir, { recursive: true, force: true });
  }
});

test("https is accepted for a remote endpoint", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, baseUrl: "https://example.invalid/v1" },
  });
  const config = await loadRuntimeConfig({ configPath: path });
  assert.equal(config.provider.baseUrl, "https://example.invalid/v1");
  await rm(dir, { recursive: true, force: true });
});

test("plaintext http is accepted for loopback hosts only", async () => {
  const loopback = [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.5.6.7:8080/v1",
    "http://[::1]:11434/v1",
  ];
  for (const url of loopback) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const config = await loadRuntimeConfig({ configPath: path });
    assert.equal(config.provider.baseUrl, url);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the base URL is an API root, not an endpoint --------------------------

test("an API root is accepted however many trailing slashes it carries", async () => {
  // Trailing slashes are not a difference in meaning. Configuration keeps the
  // text the user wrote; the adapter is what normalises it when joining.
  const roots = [
    "http://127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1/",
    "http://127.0.0.1:11434/v1///",
    "http://127.0.0.1:11434",
    "http://127.0.0.1:11434/",
    "https://example.invalid/openai/v1",
  ];
  for (const url of roots) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const config = await loadRuntimeConfig({ configPath: path });
    assert.equal(config.provider.baseUrl, url, "the configured text is preserved");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full chat-completions endpoint is refused, not silently repaired", async () => {
  // Configuring the endpoint here would make the adapter request
  // /v1/chat/completions/chat/completions. Repairing it quietly would mean the
  // configured value no longer says what it does.
  const endpoints = [
    "http://127.0.0.1:11434/v1/chat/completions",
    "http://127.0.0.1:11434/v1/chat/completions/",
    "http://127.0.0.1:11434/v1/chat/completions///",
    "https://example.invalid/v1/chat/completions",
    "https://example.invalid/chat/completions",
    "http://127.0.0.1:11434/v1/CHAT/Completions",
  ];
  for (const url of endpoints) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, "provider.baseUrl");
    // The message must say what to write instead, not merely that this is wrong.
    assert.match(error.message, /API root/);
    assert.match(error.message, /\/v1/);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path that merely resembles the endpoint is still a valid root", async () => {
  // The rule is about the endpoint this adapter appends, not about the word
  // "completions" appearing anywhere in a path.
  for (const url of [
    "https://example.invalid/chat/completions-api",
    "https://example.invalid/completions",
    "https://example.invalid/v1/chat",
  ]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const config = await loadRuntimeConfig({ configPath: path });
    assert.equal(config.provider.baseUrl, url);
    await rm(dir, { recursive: true, force: true });
  }
});

test("plaintext http to a non-loopback host is refused", async () => {
  // Otherwise a copied example would send a credential unencrypted.
  for (const url of ["http://example.invalid/v1", "http://192.168.1.10:8080/v1"]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: url },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, "provider.baseUrl");
    await rm(dir, { recursive: true, force: true });
  }
});

// --- provider kind, env name, timeout --------------------------------------

test("an unsupported provider kind is refused", async () => {
  const { dir, path } = await withConfig({
    ...MINIMAL,
    provider: { ...MINIMAL.provider, kind: "anthropic" },
  });
  const error = await expectFailure(path, "config_invalid_schema");
  assert.equal(error.field, "provider.kind");
  await rm(dir, { recursive: true, force: true });
});

test("an invalid environment-variable name is refused", async () => {
  for (const name of ["1BAD", "has-dash", "has space", "${INTERPOLATED}", ""]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, apiKeyEnv: name },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, "provider.apiKeyEnv");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a provider with no authentication is valid", async () => {
  // A local endpoint may need no credential at all.
  const { dir, path } = await withConfig(MINIMAL);
  const config = await loadRuntimeConfig({ configPath: path });
  assert.equal(config.provider.apiKeyEnv, undefined);
  await rm(dir, { recursive: true, force: true });
});

test("invalid timeout values are refused", async () => {
  for (const value of [0, -1, 1.5, "60000"]) {
    const { dir, path } = await withConfig({
      ...MINIMAL,
      provider: { ...MINIMAL.provider, timeoutMs: value },
    });
    const error = await expectFailure(path, "config_invalid_schema");
    assert.equal(error.field, "provider.timeoutMs");
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid recent-window values are refused", async () => {
  for (const key of ["maxEstimatedTokens", "reserveTokens"]) {
    for (const value of [-1, 1.5, "8000"]) {
      const { dir, path } = await withConfig({
        ...MINIMAL,
        recentWindow: { maxEstimatedTokens: 8000, [key]: value },
      });
      const error = await expectFailure(path, "config_invalid_schema");
      assert.equal(error.field, `recentWindow.${key}`);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("no error message carries a synthetic credential value", async () => {
  const planted = "sk-" + "synthetic-value-that-must-not-leak";
  const documents: unknown[] = [
    { ...MINIMAL, provider: { ...MINIMAL.provider, apiKey: planted } },
    { ...MINIMAL, provider: { ...MINIMAL.provider, apiKeyEnv: planted } },
    {
      ...MINIMAL,
      provider: { ...MINIMAL.provider, baseUrl: "https://x:" + planted + "@" + "e.invalid/v1" },
    },
  ];
  for (const document of documents) {
    const { dir, path } = await withConfig(document);
    try {
      await loadRuntimeConfig({ configPath: path });
      assert.fail("expected a failure");
    } catch (error) {
      assert.ok(error instanceof RuntimeConfigError);
      assert.ok(!error.message.includes(planted), "the error leaked the value");
    }
    await rm(dir, { recursive: true, force: true });
  }
});
