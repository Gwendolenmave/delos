/**
 * cli - synthetic tests.
 *
 * Streams, environment, working directory, identifiers, clock and `fetch` are
 * all injected. No test touches the real process or a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCli,
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USAGE,
  type CliDependencies,
} from "../surfaces/cli/run-cli.js";
import type {
  FetchLike,
  HttpResponseLike,
} from "../adapters/models/openai-compatible/openai-compatible-provider.js";

const KEY_NAME = "DELOS_TEST_CLI_KEY";
const KEY_VALUE = "sk-" + "synthetic-cli-value";

function reply(text: string): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "m", choices: [{ message: { content: text } }] }),
  };
}

interface Harness {
  deps: CliDependencies;
  out: string[];
  err: string[];
  sent: Array<Record<string, unknown>>;
}

function harness(
  cwd: string,
  input: string[],
  respond: (n: number) => HttpResponseLike = () => reply("A reply."),
  env: Record<string, string | undefined> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const queue = [...input];
  let ids = 0;

  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return respond(sent.length - 1);
  };

  return {
    out,
    err,
    sent,
    deps: {
      streams: {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        readLine: async () => (queue.length > 0 ? (queue.shift() as string) : null),
      },
      env,
      cwd,
      newId: (prefix) => `${prefix}-${++ids}`,
      now: () => "2020-01-01T00:00:00.000Z",
      fetchImpl,
    },
  };
}

async function fixture(
  overrides: Record<string, unknown> = {},
  { withPrompts = true }: { withPrompts?: boolean } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "delos-cli-test-"));
  if (withPrompts) {
    await mkdir(join(dir, "prompts"));
    await writeFile(
      join(dir, "prompts", "identity.md"),
      "You are a test assistant.\n",
      "utf8",
    );
  }
  await writeFile(
    join(dir, "delos.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      promptRoot: "./prompts",
      provider: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "example-model",
        ...(overrides["provider"] as Record<string, unknown> | undefined),
      },
      recentWindow: { maxEstimatedTokens: 8000 },
    }),
    "utf8",
  );
  return dir;
}

// --- arguments -------------------------------------------------------------

test("help is printed to stdout and succeeds", async () => {
  const h = harness("/nowhere", []);
  const code = await runCli(["--help"], h.deps);
  assert.equal(code, EXIT_OK);
  assert.ok(h.out.join("").includes("Usage:"));
  assert.equal(h.err.length, 0);
});

test("an unknown argument is a usage failure", async () => {
  const h = harness("/nowhere", []);
  const code = await runCli(["--wat"], h.deps);
  assert.equal(code, EXIT_USAGE);
  assert.ok(h.err.join("").includes("--wat"));
  assert.equal(h.out.length, 0);
});

test("a flag missing its value is a usage failure", async () => {
  for (const argv of [["--config"], ["--once"]]) {
    const h = harness("/nowhere", []);
    const code = await runCli(argv, h.deps);
    assert.equal(code, EXIT_USAGE);
  }
});

test("a repeated flag is a usage failure", async () => {
  const h = harness("/nowhere", []);
  const code = await runCli(["--config", "a", "--config", "b"], h.deps);
  assert.equal(code, EXIT_USAGE);
});

// --- one-shot --------------------------------------------------------------

test("one-shot prints only the reply and succeeds", async () => {
  const dir = await fixture();
  const h = harness(dir, [], () => reply("The capital is Lisbon."));
  const code = await runCli(["--once", "Where?"], h.deps);

  assert.equal(code, EXIT_OK);
  assert.equal(h.out.join(""), "The capital is Lisbon.\n");
  assert.equal(h.err.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("one-shot uses the default config path beside the working directory", async () => {
  const dir = await fixture();
  const h = harness(dir, []);
  const code = await runCli(["--once", "Hello."], h.deps);
  assert.equal(code, EXIT_OK);
  await rm(dir, { recursive: true, force: true });
});

test("one-shot reports a startup failure on stderr and exits non-zero", async () => {
  const dir = await fixture({}, { withPrompts: false });
  const h = harness(dir, []);
  const code = await runCli(["--once", "Hello."], h.deps);

  assert.equal(code, EXIT_FAILURE);
  assert.equal(h.out.length, 0);
  assert.ok(h.err.join("").length > 0);
  await rm(dir, { recursive: true, force: true });
});

test("one-shot reports a provider failure on stderr and exits non-zero", async () => {
  const dir = await fixture();
  const h = harness(dir, [], () => ({ ok: false, status: 500, json: async () => ({}) }));
  const code = await runCli(["--once", "Hello."], h.deps);

  assert.equal(code, EXIT_FAILURE);
  assert.equal(h.out.length, 0);
  assert.ok(h.err.join("").length > 0);
  await rm(dir, { recursive: true, force: true });
});

test("a missing credential names the variable but prints no value", async () => {
  const dir = await fixture({ provider: { apiKeyEnv: KEY_NAME } });
  const h = harness(dir, [], () => reply("hi"), { UNRELATED: KEY_VALUE });
  const code = await runCli(["--once", "Hello."], h.deps);

  assert.equal(code, EXIT_FAILURE);
  const errText = h.err.join("");
  assert.ok(errText.includes(KEY_NAME));
  assert.ok(!errText.includes(KEY_VALUE));
  await rm(dir, { recursive: true, force: true });
});

test("no secret reaches stdout or stderr on any path", async () => {
  const dir = await fixture({ provider: { apiKeyEnv: KEY_NAME } });
  for (const respond of [
    () => reply("ok"),
    () => ({ ok: false, status: 401, json: async () => ({}) }) as HttpResponseLike,
    () => ({ ok: true, status: 200, json: async () => ({ bad: true }) }) as HttpResponseLike,
  ]) {
    const h = harness(dir, [], respond, { [KEY_NAME]: KEY_VALUE });
    await runCli(["--once", "Hello."], h.deps);
    const all = h.out.join("") + h.err.join("");
    assert.ok(!all.includes(KEY_VALUE), "the credential reached a stream");
  }
  await rm(dir, { recursive: true, force: true });
});

// --- interactive -----------------------------------------------------------

test("a two-turn conversation carries the first exchange as history", async () => {
  const dir = await fixture();
  const h = harness(dir, ["First question.", "Second question.", "/exit"], (n) =>
    reply(n === 0 ? "First answer." : "Second answer."),
  );
  const code = await runCli([], h.deps);
  assert.equal(code, EXIT_OK);

  const second = h.sent[1]?.["messages"] as Array<{ role: string; content: string }>;
  assert.deepEqual(second.map((m) => `${m.role}:${m.content}`), [
    "system:You are a test assistant.",
    "user:First question.",
    "assistant:First answer.",
    "user:Second question.",
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("a failed turn is not remembered", async () => {
  const dir = await fixture();
  const h = harness(dir, ["one", "two", "/exit"], (n) =>
    n === 0
      ? ({ ok: false, status: 500, json: async () => ({}) } as HttpResponseLike)
      : reply("Second answer."),
  );
  await runCli([], h.deps);

  const second = h.sent[1]?.["messages"] as Array<{ content: string }>;
  // Only the system prompt and the new question: the failed exchange is gone.
  assert.equal(second.length, 2);
  assert.equal(second[1]?.content, "two");
  await rm(dir, { recursive: true, force: true });
});

test("blank input is ignored without a request", async () => {
  const dir = await fixture();
  const h = harness(dir, ["", "   ", "real question", "/exit"]);
  await runCli([], h.deps);
  assert.equal(h.sent.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("/quit ends the session and end of input ends it too", async () => {
  const dir = await fixture();
  for (const input of [["hi", "/quit"], ["hi"]]) {
    const h = harness(dir, input);
    const code = await runCli([], h.deps);
    assert.equal(code, EXIT_OK);
  }
  await rm(dir, { recursive: true, force: true });
});

test("/clear forgets the conversation so far", async () => {
  const dir = await fixture();
  const h = harness(dir, ["one", "/clear", "two", "/exit"]);
  await runCli([], h.deps);

  const second = h.sent[1]?.["messages"] as Array<{ content: string }>;
  assert.equal(second.length, 2, "history should have been cleared");
  await rm(dir, { recursive: true, force: true });
});

test("labels are neutral and name no persona", async () => {
  const dir = await fixture();
  const h = harness(dir, ["hi", "/exit"]);
  await runCli([], h.deps);

  const text = h.out.join("");
  assert.ok(text.includes("you>"));
  assert.ok(text.includes("assistant>"));
  await rm(dir, { recursive: true, force: true });
});

test("no files are created beside the configuration", async () => {
  // v0.1 has no persistence: history lives in the process and nowhere else.
  const dir = await fixture();
  const before = (await readdir(dir)).sort();
  const h = harness(dir, ["one", "two", "/exit"]);
  await runCli([], h.deps);
  const after = (await readdir(dir)).sort();

  assert.deepEqual(after, before);
  await rm(dir, { recursive: true, force: true });
});

test("earlier messages are never rewritten by a later turn", async () => {
  const dir = await fixture();
  const h = harness(dir, ["first", "second", "/exit"], (n) =>
    reply(n === 0 ? "answer one" : "answer two"),
  );
  await runCli([], h.deps);

  const second = h.sent[1]?.["messages"] as Array<{ content: string }>;
  assert.equal(second[1]?.content, "first");
  assert.equal(second[2]?.content, "answer one");
  await rm(dir, { recursive: true, force: true });
});
