/**
 * Delegated providers - Codex and Claude Code - against FAKE executables.
 *
 * Every process spawned here is a committed Node script under
 * tests/fixtures/delegated/; nothing contacts a network, nothing reads any
 * real tool's state. Codex is not installed on this machine, so these
 * synthetic contract tests are the required proof; the real integrations
 * remain truthfully DEGRADED until observed against installed versions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseProviderProfile,
  type ProviderProfile,
} from "../core/domain/provider-profile.js";
import { createClaudeCodeProvider, renderConversation } from "../adapters/providers/delegated/claude-code-provider.js";
import { createCodexProvider, inspectCodexAuth } from "../adapters/providers/delegated/codex-provider.js";
import { detectExecutable, runToCompletion } from "../adapters/providers/delegated/process-runner.js";
import { createProviderRegistry } from "../adapters/providers/registry.js";
import type { SecretStore } from "../core/ports/secret-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "..", "..", "tests", "fixtures", "delegated", "fake-claude.mjs");
const FAKE_CODEX = join(HERE, "..", "..", "tests", "fixtures", "delegated", "fake-codex.mjs");

function claudeProfile(overrides: Record<string, unknown> = {}): ProviderProfile {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "cc",
    kind: "delegated-claude-code",
    model: "some-model",
    executablePath: FAKE_CLAUDE,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function codexProfile(overrides: Record<string, unknown> = {}): ProviderProfile {
  return parseProviderProfile({
    schemaVersion: 1,
    id: "cx",
    kind: "delegated-codex",
    model: "codex-default",
    executablePath: FAKE_CODEX,
    timeoutMs: 5_000,
    ...overrides,
  });
}

const REQUEST = {
  conversationId: "c1",
  turnId: "t1",
  systemPrompt: "You are the delegated test persona.",
  messages: [
    { role: "user" as const, text: "First question." },
    { role: "assistant" as const, text: "First answer." },
    { role: "user" as const, text: "Second question." },
  ],
};

// --- profile validation ------------------------------------------------------

test("delegated profiles: auth defaults to none, and cannot be anything else", () => {
  const profile = claudeProfile();
  assert.equal(profile.auth.source, "none");
  assert.equal(profile.auth.transport, "none");

  assert.throws(
    () => claudeProfile({ auth: { source: "environment", transport: "bearer", secretId: "env:X", envVar: "X" } }),
    /owns its own login/,
  );
  assert.throws(() => codexProfile({ baseUrl: "http://127.0.0.1:9999" }), /must not set baseUrl/);
  assert.throws(() => claudeProfile({ headers: { "x-extra": "1" } }), /must not set headers/);
  assert.throws(
    () =>
      parseProviderProfile({
        schemaVersion: 1,
        id: "oc",
        kind: "openai-compatible",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { transport: "none" },
        executablePath: "/usr/bin/anything",
      }),
    /only valid on delegated kinds/,
  );
});

// --- rendering ---------------------------------------------------------------

test("delegated: Delos renders its own history into the prompt", () => {
  const rendered = renderConversation(REQUEST);
  assert.match(rendered, /User: First question\./);
  assert.match(rendered, /Assistant: First answer\./);
  assert.ok(rendered.indexOf("First question") < rendered.indexOf("Second question"), "order preserved");
});

// --- claude contract against the fake executable -----------------------------

test("claude delegated: a real spawned turn round-trips the documented JSON", async () => {
  const provider = createClaudeCodeProvider({ profile: claudeProfile(), workDir: tmpdir() });
  const turn = await provider.generate(REQUEST);
  assert.equal(turn.ok, true);
  if (turn.ok) {
    assert.match(turn.result.text, /^FAKE-CLAUDE:User: First question\./);
    assert.equal(turn.result.servedModel, "fake-served-model");
    assert.equal(turn.result.protocol, "claude-code-print-json");
    assert.equal(turn.result.usage?.outputTokens, 5);
  }
});

test("claude delegated: failure modes map to honest categories, raw output never relayed", async () => {
  const provider = createClaudeCodeProvider({ profile: claudeProfile(), workDir: tmpdir() });

  process.env["DELOS_FAKE_CLAUDE_MODE"] = "is-error";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "provider-error");
  } finally {
    delete process.env["DELOS_FAKE_CLAUDE_MODE"];
  }

  process.env["DELOS_FAKE_CLAUDE_MODE"] = "garbage";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "malformed-response");
  } finally {
    delete process.env["DELOS_FAKE_CLAUDE_MODE"];
  }

  process.env["DELOS_FAKE_CLAUDE_MODE"] = "exit1";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) {
      assert.equal(turn.error.code, "authentication-failed");
      assert.ok(!turn.error.message.includes("Invalid API key"), "the tool's raw stderr leaked");
      assert.match(turn.error.message, /login/i, "the message points at the official flow");
    }
  } finally {
    delete process.env["DELOS_FAKE_CLAUDE_MODE"];
  }
});

test("claude delegated: a hanging process is killed at the profile timeout", async () => {
  const provider = createClaudeCodeProvider({ profile: claudeProfile({ timeoutMs: 1_000 }), workDir: tmpdir() });
  process.env["DELOS_FAKE_CLAUDE_MODE"] = "hang";
  try {
    const before = Date.now();
    const turn = await provider.generate(REQUEST);
    assert.ok(Date.now() - before < 4_000, "the kill did not happen at the deadline");
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "timeout");
  } finally {
    delete process.env["DELOS_FAKE_CLAUDE_MODE"];
  }
});

test("claude delegated: a missing executable reports installation, not a stack", async () => {
  const provider = createClaudeCodeProvider({
    profile: claudeProfile({ executablePath: "/definitely/not/installed/claude-nope" }),
    workDir: tmpdir(),
  });
  const turn = await provider.generate(REQUEST);
  assert.equal(turn.ok, false);
  if (!turn.ok) {
    assert.equal(turn.error.code, "connection-failed");
    assert.match(turn.error.message, /not installed|not on PATH/);
  }
});

// --- codex contract against the fake executable ------------------------------

test("codex delegated: initialize, conversation, message, events, reply", async () => {
  const provider = createCodexProvider({ profile: codexProfile(), workDir: tmpdir() });
  const turn = await provider.generate(REQUEST);
  assert.equal(turn.ok, true);
  if (turn.ok) {
    assert.match(turn.result.text, /^FAKE-CODEX:\d+$/);
    assert.equal(turn.result.protocol, "codex-app-server-jsonrpc");
    assert.equal(turn.result.rawProviderMetadata?.["userAgent"], "codex-fake/9.9.9");
  }
});

test("codex delegated: auth state through the official surface, login flow pointed at", async () => {
  const provider = createCodexProvider({ profile: codexProfile(), workDir: tmpdir() });

  // Signed out: the turn refuses BEFORE any conversation, categorised as
  // authentication, pointing at codex's own documented login - and Delos
  // still never touches a credential file (the no-fs test covers the module).
  process.env["DELOS_FAKE_CODEX_MODE"] = "not-authed";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) {
      assert.equal(turn.error.code, "authentication-failed");
      assert.match(turn.error.message, /login/i, "the message points at the official flow");
      assert.ok(!turn.error.message.includes("token"), "no credential talk in the user message");
    }
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }

  // A version WITHOUT getAuthStatus degrades: the turn proceeds and succeeds.
  process.env["DELOS_FAKE_CODEX_MODE"] = "no-auth-method";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, true, "a missing auth-status method must not fail the turn");
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }
});

test("codex delegated: an unsupported protocol version is a clear error, not a probe", async () => {
  const provider = createCodexProvider({ profile: codexProfile(), workDir: tmpdir() });
  process.env["DELOS_FAKE_CODEX_MODE"] = "old-protocol";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) {
      assert.equal(turn.error.code, "protocol-error");
      assert.match(turn.error.message, /version/i);
    }
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }
});

test("codex delegated: turn errors, malformed conversations, hangs, absence", async () => {
  const provider = createCodexProvider({ profile: codexProfile(), workDir: tmpdir() });

  process.env["DELOS_FAKE_CODEX_MODE"] = "turn-error";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "provider-error");
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }

  process.env["DELOS_FAKE_CODEX_MODE"] = "bad-conversation";
  try {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "protocol-error");
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }

  process.env["DELOS_FAKE_CODEX_MODE"] = "hang";
  try {
    const hangProvider = createCodexProvider({ profile: codexProfile({ timeoutMs: 1_000 }), workDir: tmpdir() });
    const turn = await hangProvider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) assert.equal(turn.error.code, "timeout");
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }

  const missing = createCodexProvider({
    profile: codexProfile({ executablePath: "/definitely/not/installed/codex-nope" }),
    workDir: tmpdir(),
  });
  const turn = await missing.generate(REQUEST);
  assert.equal(turn.ok, false);
  if (!turn.ok) assert.equal(turn.error.code, "connection-failed");
});

// --- registry integration ----------------------------------------------------

test("registry: delegated kinds resolve, and the secret store is NEVER consulted", async () => {
  let lookups = 0;
  const secretStore: SecretStore = {
    name: "counting",
    writable: false,
    has: async () => {
      lookups++;
      return false;
    },
    get: async () => {
      lookups++;
      return { found: false, reason: "not_configured", detail: "none" };
    },
  };
  const workDir = await mkdtemp(join(tmpdir(), "delos-delegated-"));
  try {
    const registry = createProviderRegistry({ secretStore, delegatedWorkDir: workDir });
    const provider = registry.createFromProfile(claudeProfile());
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, true);
    assert.equal(lookups, 0, "a delegated provider consulted the secret store");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("codex delegated: doctor's auth inspection reads the official surface, read-only", async () => {
  const signedIn = await inspectCodexAuth(codexProfile(), { workDir: tmpdir() });
  assert.deepEqual(
    { supported: signedIn.supported, authenticated: signedIn.authenticated },
    { supported: true, authenticated: true },
  );
  assert.ok(!signedIn.detail.includes("@"), "no account identifier in the inspection");

  process.env["DELOS_FAKE_CODEX_MODE"] = "not-authed";
  try {
    const signedOut = await inspectCodexAuth(codexProfile(), { workDir: tmpdir() });
    assert.equal(signedOut.authenticated, false);
    assert.match(signedOut.detail, /login/i);
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }

  process.env["DELOS_FAKE_CODEX_MODE"] = "no-auth-method";
  try {
    const unsupported = await inspectCodexAuth(codexProfile(), { workDir: tmpdir() });
    assert.equal(unsupported.supported, false);
    assert.match(unsupported.detail, /per turn/);
  } finally {
    delete process.env["DELOS_FAKE_CODEX_MODE"];
  }
});

test("delegated: no bounded working directory means refusal, never the caller's cwd", async () => {
  // Neither adapter may fall back to process.cwd() - that could be a
  // repository checkout or anything private. Missing bound = fail closed.
  for (const provider of [
    createClaudeCodeProvider({ profile: claudeProfile() }),
    createCodexProvider({ profile: codexProfile() }),
  ]) {
    const turn = await provider.generate(REQUEST);
    assert.equal(turn.ok, false);
    if (!turn.ok) {
      assert.equal(turn.error.code, "profile-invalid");
      assert.match(turn.error.message, /bounded working directory/);
    }
  }
});

// --- detection ---------------------------------------------------------------

test("detection: version for a present tool, honest absence for a missing one", async () => {
  const cwd = process.cwd();
  const present = await detectExecutable(runToCompletion, FAKE_CLAUDE, cwd);
  assert.equal(present.installed, true);
  assert.match(present.version ?? "", /9\.9\.9-fake/);

  const absent = await detectExecutable(runToCompletion, "/definitely/not/installed/codex-nope", cwd);
  assert.equal(absent.installed, false);
  assert.match(absent.detail, /not installed|could not be started/);
});

// --- the no-file-access boundary --------------------------------------------

test("delegated adapters open no files: the compiled module imports no fs API", async () => {
  const delegatedDir = join(HERE, "..", "adapters", "providers", "delegated");
  const files = await readdir(delegatedDir);
  assert.ok(files.length >= 3, "the compiled delegated adapters exist");
  for (const file of files) {
    const source = await readFile(join(delegatedDir, file), "utf8");
    assert.ok(!source.includes("node:fs"), `${file} imports the filesystem`);
    assert.ok(!source.includes("readFile"), `${file} reads files`);
    assert.ok(!/require\(["']fs["']\)/.test(source), `${file} requires fs`);
  }
});
