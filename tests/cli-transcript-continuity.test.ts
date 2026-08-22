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

function reply(text: string): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "synthetic-model", choices: [{ message: { content: text } }] }),
  };
}

interface Harness {
  readonly deps: CliDependencies;
  readonly sent: Array<Record<string, unknown>>;
  readonly out: string[];
  readonly err: string[];
}

function harness(
  cwd: string,
  dataDir: string,
  idNamespace: string,
  input: readonly string[],
  respond: (n: number) => HttpResponseLike = () => reply("Synthetic reply."),
): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...input];
  let ids = 0;

  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return respond(sent.length - 1);
  };

  return {
    sent,
    out,
    err,
    deps: {
      streams: {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
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

function syntheticConfig(): string {
  return JSON.stringify({
    schemaVersion: 1,
    promptRoot: "./prompts",
    provider: {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "synthetic-model",
    },
    recentWindow: { maxEstimatedTokens: 8000 },
  });
}

async function fixture(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "delos-public-cli-continuity-"));
  await mkdir(join(root, "prompts"));
  await writeFile(join(root, "prompts", "identity.md"), "You are a synthetic assistant.\n", "utf8");
  await writeFile(join(root, "delos.config.json"), syntheticConfig(), "utf8");
  return { root, dataDir: join(root, "runtime-data") };
}

function messageSequence(request: Record<string, unknown> | undefined): string[] {
  const messages = request?.["messages"] as Array<{ role: string; content: string }> | undefined;
  return (messages ?? []).map((message) => `${message.role}:${message.content}`);
}

test("completed interactive turns resume from the durable transcript after restart", async () => {
  const { root, dataDir } = await fixture();
  try {
    const first = harness(root, dataDir, "first", ["First question.", "/exit"], () => reply("First answer."));
    assert.equal(await runCli([], first.deps), EXIT_OK);

    const second = harness(root, dataDir, "second", ["Second question.", "/exit"], () => reply("Second answer."));
    assert.equal(await runCli([], second.deps), EXIT_OK);

    assert.deepEqual(messageSequence(second.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:First question.",
      "assistant:First answer.",
      "user:Second question.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different config files sharing one app-data root never share transcript history", async () => {
  const { root, dataDir } = await fixture();
  try {
    await writeFile(join(root, "other.config.json"), syntheticConfig(), "utf8");

    const first = harness(root, dataDir, "config-a", ["Private first question.", "/exit"], () => reply("Private first answer."));
    assert.equal(await runCli([], first.deps), EXIT_OK);

    const other = harness(root, dataDir, "config-b", ["Other configuration question.", "/exit"], () => reply("Other configuration answer."));
    assert.equal(await runCli(["--config", "other.config.json"], other.deps), EXIT_OK);
    assert.deepEqual(messageSequence(other.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Other configuration question.",
    ]);

    const resumed = harness(root, dataDir, "config-a-resume", ["Private second question.", "/exit"], () => reply("Private second answer."));
    assert.equal(await runCli([], resumed.deps), EXIT_OK);
    assert.deepEqual(messageSequence(resumed.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Private first question.",
      "assistant:Private first answer.",
      "user:Private second question.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed turn remains evidence but is not restored as completed dialogue", async () => {
  const { root, dataDir } = await fixture();
  try {
    const failed = harness(root, dataDir, "failed", ["Unanswered question.", "/exit"], () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    await runCli([], failed.deps);

    const resumed = harness(root, dataDir, "resumed", ["Fresh question.", "/exit"], () => reply("Fresh answer."));
    assert.equal(await runCli([], resumed.deps), EXIT_OK);
    assert.deepEqual(messageSequence(resumed.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Fresh question.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/clear rotates to a fresh durable conversation without deleting the old transcript", async () => {
  const { root, dataDir } = await fixture();
  try {
    const first = harness(
      root,
      dataDir,
      "clear-a",
      ["Old question.", "/clear", "New question.", "/exit"],
      (n) => reply(n === 0 ? "Old answer." : "New answer."),
    );
    assert.equal(await runCli([], first.deps), EXIT_OK);
    assert.deepEqual(messageSequence(first.sent[1]), [
      "system:You are a synthetic assistant.",
      "user:New question.",
    ]);

    const resumed = harness(root, dataDir, "clear-b", ["After restart.", "/exit"], () => reply("After answer."));
    assert.equal(await runCli([], resumed.deps), EXIT_OK);
    assert.deepEqual(messageSequence(resumed.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:New question.",
      "assistant:New answer.",
      "user:After restart.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot invocations are transcripted separately and never enter interactive resume context", async () => {
  const { root, dataDir } = await fixture();
  try {
    const first = harness(root, dataDir, "interactive-a", ["Interactive one.", "/exit"], () => reply("Interactive answer."));
    assert.equal(await runCli([], first.deps), EXIT_OK);

    const once = harness(root, dataDir, "once", [], () => reply("Script answer."));
    assert.equal(await runCli(["--once", "Script question."], once.deps), EXIT_OK);

    const resumed = harness(root, dataDir, "interactive-b", ["Interactive two.", "/exit"], () => reply("Second answer."));
    assert.equal(await runCli([], resumed.deps), EXIT_OK);
    assert.deepEqual(messageSequence(resumed.sent[0]), [
      "system:You are a synthetic assistant.",
      "user:Interactive one.",
      "assistant:Interactive answer.",
      "user:Interactive two.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
