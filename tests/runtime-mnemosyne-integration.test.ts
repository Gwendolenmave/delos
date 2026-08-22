import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import {
  createRuntime,
  describeStartupFailure,
  type FetchLike,
} from "../composition/create-runtime.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "public-delos-memory-"));
  const prompts = join(root, "prompts");
  await mkdir(prompts);
  await writeFile(join(prompts, "identity.md"), "You are a synthetic assistant.\n", "utf8");
  const configPath = join(root, "delos.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      promptRoot: "./prompts",
      provider: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:9999/v1",
        model: "synthetic-model",
        timeoutMs: 1000,
      },
      recentWindow: { maxEstimatedTokens: 1000, reserveTokens: 10 },
    }),
    "utf8",
  );
  return { root, configPath };
}

function fetchCapture(calls: Array<Record<string, unknown>>): FetchLike {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "synthetic-model",
          choices: [{ message: { content: "synthetic reply" } }],
        };
      },
    };
  };
}

test("explicit mnemosyne mode attaches the package read path to a public Delos turn", async () => {
  const { root, configPath } = await fixture();
  const calls: Array<Record<string, unknown>> = [];
  let openedPath = "";
  let closed = 0;
  let packetQuery = "";

  const runtime = await createRuntime({
    configPath,
    env: {
      DELOS_MEMORY_BACKEND: "mnemosyne",
      DELOS_MEMORY_DB_PATH: "./mnemosyne.db",
    },
    fetchImpl: fetchCapture(calls),
    memoryPackageLoader: async (specifier) => {
      assert.equal(specifier, "@delos/mnemosyne");
      return {
        SqliteMnemosyne: {
          openMnemosyne(path: unknown) {
            openedPath = String(path);
            return { store: { synthetic: true }, log: { close: () => void (closed += 1) } };
          },
        },
        Anamnesis: {
          buildMemoryReadPacket(input: unknown) {
            packetQuery = String((input as Record<string, unknown>)["query"]);
            return { synthetic: true };
          },
          renderMemoryPacket() {
            return "synthetic remembered preference";
          },
        },
      };
    },
  });

  const outcome = await runtime.turnService.runTurn({
    conversationId: "conv-1",
    turnId: "turn-1",
    history: [],
    userText: "hello",
    atIso: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(outcome.ok, true);
  assert.equal(packetQuery, "hello");
  assert.equal(openedPath, join(root, "mnemosyne.db"));
  assert.equal(isAbsolute(openedPath), true);
  assert.equal(calls.length, 1);

  const messages = calls[0]?.["messages"] as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /host-retrieved data/);
  assert.doesNotMatch(messages[0]?.content ?? "", /synthetic remembered preference/);
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[1]?.content ?? "", /synthetic remembered preference/);
  assert.ok((messages[1]?.content ?? "").endsWith("=== CURRENT USER MESSAGE ===\nhello\n=== END CURRENT USER MESSAGE ==="));

  await runtime.close();
  await runtime.close();
  assert.equal(closed, 1);
});

test("memory off is the default and never loads the optional package", async () => {
  const { configPath } = await fixture();
  const calls: Array<Record<string, unknown>> = [];
  let packageLoads = 0;
  const runtime = await createRuntime({
    configPath,
    env: { DELOS_MEMORY_DB_PATH: "./ignored.db" },
    fetchImpl: fetchCapture(calls),
    memoryPackageLoader: async () => {
      packageLoads += 1;
      throw new Error("must not load");
    },
  });

  await runtime.turnService.runTurn({
    conversationId: "conv-off",
    turnId: "turn-off",
    history: [],
    userText: "hello",
    atIso: "2026-08-22T00:00:00.000Z",
  });
  const messages = calls[0]?.["messages"] as Array<{ role: string; content: string }>;
  assert.equal(packageLoads, 0);
  assert.equal(messages[1]?.content, "hello");
  assert.doesNotMatch(messages[0]?.content ?? "", /DELOS HOST CONTEXT|host-retrieved data/);
  await runtime.close();
});

test("mnemosyne activation requires an explicit database path", async () => {
  const { configPath } = await fixture();
  await assert.rejects(
    createRuntime({
      configPath,
      env: { DELOS_MEMORY_BACKEND: "mnemosyne" },
      fetchImpl: fetchCapture([]),
      memoryPackageLoader: async () => {
        throw new Error("must not load");
      },
    }),
    (error: unknown) => {
      assert.equal(
        describeStartupFailure(error),
        "Memory backend mnemosyne requires DELOS_MEMORY_DB_PATH.",
      );
      return true;
    },
  );
});

test("unsupported memory backend text is never echoed", async () => {
  const { configPath } = await fixture();
  const planted = "PRIVATE_" + "VALUE_SHOULD_NOT_APPEAR";
  await assert.rejects(
    createRuntime({
      configPath,
      env: { DELOS_MEMORY_BACKEND: planted },
      fetchImpl: fetchCapture([]),
    }),
    (error: unknown) => {
      const message = describeStartupFailure(error);
      assert.equal(message, "Unsupported DELOS_MEMORY_BACKEND. Expected off or mnemosyne.");
      assert.doesNotMatch(message, /PRIVATE_VALUE_SHOULD_NOT_APPEAR/);
      return true;
    },
  );
});

test("configured memory package failures surface only fixed safe startup text", async () => {
  const { configPath } = await fixture();
  await assert.rejects(
    createRuntime({
      configPath,
      env: {
        DELOS_MEMORY_BACKEND: "mnemosyne",
        DELOS_MEMORY_DB_PATH: "./mnemosyne.db",
      },
      fetchImpl: fetchCapture([]),
      memoryPackageLoader: async () => {
        throw new Error("PRIVATE LOADER DETAIL");
      },
    }),
    (error: unknown) => {
      const message = describeStartupFailure(error);
      assert.match(message, /@delos\/mnemosyne is not installed/);
      assert.doesNotMatch(message, /PRIVATE LOADER DETAIL/);
      assert.doesNotMatch(message, /mnemosyne\.db/);
      return true;
    },
  );
});
