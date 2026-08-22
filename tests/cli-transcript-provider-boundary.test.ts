import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, EXIT_OK, type CliDependencies } from "../surfaces/cli/run-cli.js";
import type {
  FetchLike,
  HttpResponseLike,
} from "../adapters/models/openai-compatible/openai-compatible-provider.js";

function reply(text: string, model = "synthetic-model"): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model, choices: [{ message: { content: text } }] }),
  };
}

interface Harness {
  readonly deps: CliDependencies;
  readonly sent: Array<Record<string, unknown>>;
}

function harness(
  cwd: string,
  dataDir: string,
  idNamespace: string,
  input: readonly string[],
  respond: (n: number) => HttpResponseLike = () => reply("Synthetic reply."),
): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const queue = [...input];
  let ids = 0;

  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return respond(sent.length - 1);
  };

  return {
    sent,
    deps: {
      streams: {
        stdout: () => undefined,
        stderr: () => undefined,
        readLine: async () => (queue.length > 0 ? (queue.shift() as string) : null),
      },
      env: {},
      cwd,
      dataDir,
      newId: (prefix) => `${idNamespace}-${prefix}-${++ids}`,
      now: () => "2026-01-01T00:00:00.000Z",
      fetchImpl,
    },
  };
}

function v1Config(model: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    promptRoot: "./prompts",
    provider: {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model,
    },
    recentWindow: { maxEstimatedTokens: 8000 },
  });
}

function v2Config(): string {
  return JSON.stringify({
    schemaVersion: 2,
    promptRoot: "./prompts",
    providers: [
      {
        schemaVersion: 1,
        id: "alpha",
        kind: "openai-compatible",
        model: "alpha-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        auth: { transport: "none" },
      },
      {
        schemaVersion: 1,
        id: "beta",
        kind: "openai-compatible",
        model: "beta-model",
        baseUrl: "http://127.0.0.1:11435/v1",
        auth: { transport: "none" },
      },
    ],
    defaultProvider: "alpha",
    recentWindow: { maxEstimatedTokens: 8000 },
  });
}

async function fixture(config: string): Promise<{ root: string; dataDir: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "delos-public-provider-boundary-"));
  await mkdir(join(root, "prompts"));
  await writeFile(join(root, "prompts", "identity.md"), "You are a synthetic assistant.\n", "utf8");
  const configPath = join(root, "delos.config.json");
  await writeFile(configPath, config, "utf8");
  return { root, dataDir: join(root, "runtime-data"), configPath };
}

function messageSequence(request: Record<string, unknown> | undefined): string[] {
  const messages = request?.["messages"] as Array<{ role: string; content: string }> | undefined;
  return (messages ?? []).map((message) => `${message.role}:${message.content}`);
}

test("editing an inline provider in place does not reuse the previous transcript", async () => {
  const { root, dataDir, configPath } = await fixture(v1Config("first-model"));
  try {
    const first = harness(root, dataDir, "first", ["First provider question.", "/exit"], () =>
      reply("First provider answer.", "first-model"),
    );
    assert.equal(await runCli([], first.deps), EXIT_OK);

    await writeFile(configPath, v1Config("second-model"), "utf8");

    const second = harness(root, dataDir, "second", ["Second provider question.", "/exit"], () =>
      reply("Second provider answer.", "second-model"),
    );
    assert.equal(await runCli([], second.deps), EXIT_OK);
    assert.deepEqual(messageSequence(second.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Second provider question.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider profiles in one config have isolated transcript continuity", async () => {
  const { root, dataDir } = await fixture(v2Config());
  try {
    const alpha = harness(root, dataDir, "alpha-a", ["Alpha one.", "/exit"], () =>
      reply("Alpha answer.", "alpha-model"),
    );
    assert.equal(await runCli(["--provider", "alpha"], alpha.deps), EXIT_OK);

    const beta = harness(root, dataDir, "beta", ["Beta one.", "/exit"], () =>
      reply("Beta answer.", "beta-model"),
    );
    assert.equal(await runCli(["--provider", "beta"], beta.deps), EXIT_OK);
    assert.deepEqual(messageSequence(beta.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Beta one.",
    ]);

    const alphaAgain = harness(root, dataDir, "alpha-b", ["Alpha two.", "/exit"], () =>
      reply("Alpha second answer.", "alpha-model"),
    );
    assert.equal(await runCli(["--provider", "alpha"], alphaAgain.deps), EXIT_OK);
    assert.deepEqual(messageSequence(alphaAgain.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Alpha one.",
      "assistant:Alpha answer.",
      "user:Alpha two.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
