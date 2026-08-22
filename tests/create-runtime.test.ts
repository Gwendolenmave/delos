/**
 * create-runtime - synthetic tests.
 *
 * The environment is injected, `fetch` is injected, and every file lives in a
 * fresh temporary directory. Nothing reads the real environment or a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntime,
  describeStartupFailure,
  RuntimeStartupError,
  type EnvironmentLike,
} from "../composition/create-runtime.js";
import { RuntimeConfigError } from "../adapters/config/filesystem/runtime-config.js";
import { PromptLoadError } from "../adapters/identity/filesystem/prompt-loader.js";
import {
  createOpenAICompatibleProvider,
  type FetchLike,
  type HttpResponseLike,
} from "../adapters/models/openai-compatible/openai-compatible-provider.js";

const KEY_NAME = "DELOS_TEST_RUNTIME_KEY";
const KEY_VALUE = "sk-" + "synthetic-runtime-value";

function reply(text: string): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "m", choices: [{ message: { content: text } }] }),
  };
}

interface Fixture {
  dir: string;
  configPath: string;
}

async function makeFixture(
  configOverrides: Record<string, unknown> = {},
  { withPrompts = true }: { withPrompts?: boolean } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "delos-runtime-test-"));
  if (withPrompts) {
    await mkdir(join(dir, "prompts"));
    await writeFile(join(dir, "prompts", "identity.md"), "You are a test assistant.\n", "utf8");
  }
  const config = {
    schemaVersion: 1,
    promptRoot: "./prompts",
    provider: {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "example-model",
      ...(configOverrides["provider"] as Record<string, unknown> | undefined),
    },
    recentWindow: { maxEstimatedTokens: 8000 },
    ...Object.fromEntries(
      Object.entries(configOverrides).filter(([k]) => k !== "provider"),
    ),
  };
  const configPath = join(dir, "delos.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return { dir, configPath };
}

function captureFetch(): { fetchImpl: FetchLike; headers: Array<Record<string, string>> } {
  const headers: Array<Record<string, string>> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    headers.push(init.headers);
    return reply("A reply.");
  };
  return { fetchImpl, headers };
}

// --- valid startup ---------------------------------------------------------

test("a no-auth configuration produces a working runtime", async () => {
  const { dir, configPath } = await makeFixture();
  const { fetchImpl, headers } = captureFetch();
  const runtime = await createRuntime({ configPath, env: {}, fetchImpl });

  const outcome = await runtime.turnService.runTurn({
    conversationId: "c-1",
    turnId: "t-1",
    history: [],
    userText: "Hello.",
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.replyText, "A reply.");
  assert.equal(headers[0]?.["Authorization"], undefined);

  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

test("a named environment variable supplies the credential", async () => {
  const { dir, configPath } = await makeFixture({ provider: { apiKeyEnv: KEY_NAME } });
  const { fetchImpl, headers } = captureFetch();
  const env: EnvironmentLike = { [KEY_NAME]: KEY_VALUE };
  const runtime = await createRuntime({ configPath, env, fetchImpl });

  await runtime.turnService.runTurn({
    conversationId: "c-1",
    turnId: "t-1",
    history: [],
    userText: "Hello.",
  });
  assert.equal(headers[0]?.["Authorization"], `Bearer ${KEY_VALUE}`);

  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

test("the configured window budget reaches the turn service", async () => {
  const { dir, configPath } = await makeFixture({
    recentWindow: { maxEstimatedTokens: 0 },
  });
  let sentCount = -1;
  const fetchImpl: FetchLike = async (_url, init) => {
    const payload = JSON.parse(init.body) as { messages: unknown[] };
    sentCount = payload.messages.length;
    return reply("ok");
  };
  const runtime = await createRuntime({ configPath, env: {}, fetchImpl });

  await runtime.turnService.runTurn({
    conversationId: "c-1",
    turnId: "t-1",
    history: [
      { role: "user", text: "old one" },
      { role: "assistant", text: "old two" },
    ],
    userText: "current",
  });
  // System prompt plus the current message only: a zero budget dropped the
  // history but never the current message.
  assert.equal(sentCount, 2);

  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

// --- credential failures ---------------------------------------------------

test("a missing named environment variable is a typed startup failure", async () => {
  const { dir, configPath } = await makeFixture({ provider: { apiKeyEnv: KEY_NAME } });
  await assert.rejects(
    () => createRuntime({ configPath, env: {}, fetchImpl: captureFetch().fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.equal(error.kind, "credential_missing");
      assert.ok(error.message.includes(KEY_NAME), "the variable should be named");
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("an empty named environment variable is also a failure", async () => {
  const { dir, configPath } = await makeFixture({ provider: { apiKeyEnv: KEY_NAME } });
  await assert.rejects(
    () =>
      createRuntime({
        configPath,
        env: { [KEY_NAME]: "" },
        fetchImpl: captureFetch().fetchImpl,
      }),
    RuntimeStartupError,
  );
  await rm(dir, { recursive: true, force: true });
});

test("no environment value is ever printed, and the environment is not enumerated", async () => {
  const { dir, configPath } = await makeFixture({ provider: { apiKeyEnv: KEY_NAME } });
  const other = "OTHER-SECRET-MUST-NOT-APPEAR";
  const readKeys: string[] = [];
  // A proxy records every key actually read.
  const env = new Proxy(
    { UNRELATED: other } as Record<string, string | undefined>,
    {
      get(target, key: string) {
        readKeys.push(key);
        return target[key];
      },
      ownKeys() {
        throw new Error("the environment must not be enumerated");
      },
    },
  );

  await assert.rejects(
    () => createRuntime({ configPath, env, fetchImpl: captureFetch().fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.ok(!error.message.includes(other));
      return true;
    },
  );
  assert.deepEqual(readKeys, [KEY_NAME], "only the named variable may be read");
  await rm(dir, { recursive: true, force: true });
});

// --- other startup failures ------------------------------------------------

test("a configuration failure propagates with its own typed error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-runtime-test-"));
  await assert.rejects(
    () =>
      createRuntime({
        configPath: join(dir, "absent.json"),
        env: {},
        fetchImpl: captureFetch().fetchImpl,
      }),
    RuntimeConfigError,
  );
  await rm(dir, { recursive: true, force: true });
});

test("an identity failure propagates with its own typed error", async () => {
  const { dir, configPath } = await makeFixture({}, { withPrompts: false });
  await assert.rejects(
    () => createRuntime({ configPath, env: {}, fetchImpl: captureFetch().fetchImpl }),
    PromptLoadError,
  );
  await rm(dir, { recursive: true, force: true });
});

test("an unsupported provider kind is refused by configuration before composition", async () => {
  const { dir, configPath } = await makeFixture({ provider: { kind: "anthropic" } });
  await assert.rejects(
    () => createRuntime({ configPath, env: {}, fetchImpl: captureFetch().fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeConfigError);
      assert.equal(error.field, "provider.kind");
      return true;
    },
  );
  await rm(dir, { recursive: true, force: true });
});

test("a failed startup returns nothing partially built", async () => {
  const { dir, configPath } = await makeFixture(
    { provider: { apiKeyEnv: KEY_NAME } },
    { withPrompts: false },
  );
  let runtime: unknown;
  try {
    runtime = await createRuntime({
      configPath,
      env: { [KEY_NAME]: KEY_VALUE },
      fetchImpl: captureFetch().fetchImpl,
    });
  } catch (error) {
    assert.ok(error instanceof PromptLoadError);
    // The credential resolved, but nothing usable was returned, and the
    // failure did not carry it.
    assert.ok(!String(error.message).includes(KEY_VALUE));
  }
  assert.equal(runtime, undefined);
  await rm(dir, { recursive: true, force: true });
});

// --- the safe startup message boundary -------------------------------------

const UNKNOWN_LINE = "Delos could not start.";
const LEAK_MARKER = "STARTUP-DETAIL-MUST-NOT-APPEAR";

test("the three known startup failures keep their own useful message", () => {
  assert.equal(
    describeStartupFailure(
      new RuntimeConfigError("config_invalid_schema", "provider.model must be a string", "provider.model"),
    ),
    "provider.model must be a string",
  );
  assert.equal(
    describeStartupFailure(new PromptLoadError("prompt_root_missing", "Prompt root does not exist: /tmp/x")),
    "Prompt root does not exist: /tmp/x",
  );
  assert.equal(
    describeStartupFailure(
      new RuntimeStartupError("credential_missing", `... environment variable ${KEY_NAME} ...`),
    ),
    `... environment variable ${KEY_NAME} ...`,
  );
});

test("an unrecognised Error never has its message forwarded", () => {
  const message = describeStartupFailure(new Error(LEAK_MARKER));
  assert.equal(message, UNKNOWN_LINE);
  assert.ok(!message.includes(LEAK_MARKER));
});

test("an unrecognised Error subclass is not trusted either", () => {
  class SomeDependencyError extends Error {}
  const message = describeStartupFailure(new SomeDependencyError(LEAK_MARKER));
  assert.equal(message, UNKNOWN_LINE);
});

test("an object merely shaped like a known error is not trusted", () => {
  // Recognition is by type, not by duck-typing: a thrown value that happens to
  // carry `name`, `kind` and `message` is still an unknown.
  const impostor = {
    name: "RuntimeConfigError",
    kind: "config_invalid_json",
    message: LEAK_MARKER,
  };
  assert.equal(describeStartupFailure(impostor), UNKNOWN_LINE);
});

test("non-Error throws collapse to the fixed line", () => {
  for (const thrown of [LEAK_MARKER, null, undefined, 42, { message: LEAK_MARKER }, [LEAK_MARKER]]) {
    assert.equal(describeStartupFailure(thrown), UNKNOWN_LINE);
  }
});

// --- lifecycle -------------------------------------------------------------

/**
 * What this proves, and what it does not.
 *
 * The only provider v0.1 builds holds no closeable resource, so it implements
 * no `close()`. This test therefore proves that repeated `close()` on the
 * runtime is safe - which is the property a surface actually relies on, since
 * an interrupt handler and a normal exit path may both call it.
 *
 * It does NOT prove that an underlying provider is closed exactly once,
 * because with this implementation there is nothing to count. Manufacturing a
 * count here would mean adding a provider registry, an injection seam or a
 * test-only production API to the composition root - machinery built to make
 * an assertion true rather than to make the program work.
 *
 * The exact-once lifecycle test belongs with the first adapter that really
 * holds a resource - a connection pool, a socket, a child process - and should
 * be written against that real implementation.
 */
test("closing the runtime repeatedly is safe", async () => {
  const { dir, configPath } = await makeFixture();
  const runtime = await createRuntime({
    configPath,
    env: {},
    fetchImpl: captureFetch().fetchImpl,
  });

  await runtime.close();
  await runtime.close();
  await runtime.close();
  // No throw is the assertion.
  assert.ok(true);
  await rm(dir, { recursive: true, force: true });
});

test("the v0.1 provider has nothing to close, which is why the above cannot count", () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "example-model",
    timeoutMs: 1000,
  });
  // Stated as a fact about this implementation rather than left implicit, so
  // the day an adapter grows a close() this test fails and the claim above is
  // revisited deliberately.
  assert.equal(provider.close, undefined);
});

test("two runtimes are independent", async () => {
  const a = await makeFixture();
  const b = await makeFixture();
  const first = await createRuntime({
    configPath: a.configPath,
    env: {},
    fetchImpl: captureFetch().fetchImpl,
  });
  const second = await createRuntime({
    configPath: b.configPath,
    env: {},
    fetchImpl: captureFetch().fetchImpl,
  });

  assert.notEqual(first, second);
  assert.notEqual(first.turnService, second.turnService);
  await first.close();
  await second.close();
  await rm(a.dir, { recursive: true, force: true });
  await rm(b.dir, { recursive: true, force: true });
});

test("the runtime exposes nothing but a turn service and close", async () => {
  const { dir, configPath } = await makeFixture();
  const runtime = await createRuntime({
    configPath,
    env: {},
    fetchImpl: captureFetch().fetchImpl,
  });
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "turnService"]);
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});
