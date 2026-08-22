/**
 * End-to-end proof of the configurable conversation path.
 *
 *   local JSON configuration
 *     -> filesystem identity adapter
 *     -> assembled system prompt
 *     -> recent history selection
 *     -> current user message
 *     -> OpenAI-compatible model adapter
 *     -> reply sanitization
 *     -> CLI reference surface
 *
 * The provider is a synthetic HTTP server bound to 127.0.0.1 on an
 * OS-assigned port. **No external network is used, no real provider is
 * called, and no real credential exists.** Nothing here demonstrates that
 * Delos works with any particular vendor - only that the path is wired.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { runCli, type CliDependencies } from "../surfaces/cli/run-cli.js";

/** Compiled CLI entry, relative to this compiled test. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "surfaces", "cli", "main.js");

const KEY_NAME = "DELOS_E2E_SYNTHETIC_KEY";
const KEY_VALUE = "sk-" + "e2e-synthetic-value-0000";
const SYSTEM_TEXT = "You are a synthetic test assistant for an automated check.";
const USER_TEXT = "Synthetic probe message zero one.";

// Real child CLIs intentionally receive a tiny synthetic application-data root.
// The production CLI now persists transcripts, so a fixture that strips HOME/XDG
// without supplying DELOS_DATA_DIR no longer satisfies the runtime contract.
// One root per test-file process is enough: every workspace has a distinct
// resolved config path, and transcript scoping keeps those conversations apart.
const CHILD_DATA_DIR = mkdtemp(join(tmpdir(), "delos-e2e-data-"));
after(async () => {
  await rm(await CHILD_DATA_DIR, { recursive: true, force: true });
});

interface Captured {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

interface Loopback {
  readonly url: string;
  readonly received: Captured[];
  close(): Promise<void>;
}

type Handler = (n: number, res: ServerResponse) => void;

/** A provider that exists only on loopback, for the length of one test. */
async function loopbackProvider(handler: Handler): Promise<Loopback> {
  const received: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        authorization: req.headers["authorization"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      handler(received.length - 1, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // A failed assertion must not turn a useful test failure into a repository-
  // wide hang merely because its synthetic listener has not reached cleanup.
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    received,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function respondOk(res: ServerResponse, content: string, model = "synthetic-served"): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }));
}

async function workspace(
  baseUrl: string,
  extraProvider: Record<string, unknown> = {},
  { withPrompts = true }: { withPrompts?: boolean } = {},
): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "delos-e2e-"));
  if (withPrompts) {
    await mkdir(join(dir, "prompts"));
    await writeFile(join(dir, "prompts", "identity.md"), `${SYSTEM_TEXT}\n`, "utf8");
  }
  const configPath = join(dir, "delos.config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        promptRoot: "./prompts",
        provider: {
          kind: "openai-compatible",
          baseUrl,
          model: "synthetic-configured-model",
          apiKeyEnv: KEY_NAME,
          timeoutMs: 5000,
          ...extraProvider,
        },
        recentWindow: { maxEstimatedTokens: 4000 },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, configPath };
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const POLL_MS = 20;
const WAIT_LIMIT_MS = 15_000;
const CHILD_LIMIT_MS = 12_000;

/** Run the real compiled CLI as a child process. */
async function runCliProcess(
  args: readonly string[],
  env: Record<string, string>,
): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      DELOS_DATA_DIR: await CHILD_DATA_DIR,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

  return await new Promise<CliRun>((resolveRun) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_LIMIT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code,
        stdout,
        stderr:
          signal === null
            ? stderr
            : `${stderr}\nSynthetic CLI child terminated by ${signal}.\n`,
      });
    });
  });
}

/** Wait for a condition the child process is expected to reach. */
async function until(ready: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${describe()}`);
    await new Promise((tick) => setTimeout(tick, POLL_MS));
  }
}

interface InteractiveRun {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  write(line: string): void;
  interrupt(): void;
  readonly finished: Promise<{ code: number | null; signal: string | null }>;
}

/** Run the real compiled CLI interactively, with a live stdin. */
async function startCliProcess(
  args: readonly string[],
  env: Record<string, string>,
): Promise<InteractiveRun> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      DELOS_DATA_DIR: await CHILD_DATA_DIR,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));

  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_LIMIT_MS);
  const finished = once(child, "close").then((values) => {
    clearTimeout(timer);
    const [code, signal] = values as [number | null, string | null];
    return { code, signal };
  });

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    write: (line) => child.stdin?.write(line),
    interrupt: () => child.kill("SIGINT"),
    finished,
  };
}

// --- the primary proof -----------------------------------------------------

test("the whole configured path runs end to end through the real CLI", async () => {
  // The reply carries CRLF and a terminal colour sequence, so sanitization is
  // proven by the output rather than asserted about.
  const esc = String.fromCharCode(27);
  const rawReply = `${esc}[31mLine one.\r\nLine two.${esc}[0m`;

  const server = await loopbackProvider((_n, res) => respondOk(res, rawReply));
  const { dir, configPath } = await workspace(server.url);

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
    [KEY_NAME]: KEY_VALUE,
  });

  // -- the process succeeded and printed only the sanitized reply ----------
  assert.equal(run.code, 0, `stderr: ${run.stderr}`);
  assert.equal(run.stdout, "Line one.\nLine two.\n");
  assert.ok(!run.stdout.includes("\r"), "CRLF survived");
  assert.ok(!run.stdout.includes("31m"), "a terminal sequence survived");
  assert.equal(run.stderr, "");

  // -- the credential travelled only in the Authorization header ------------
  const call = server.received[0];
  assert.ok(call);
  assert.equal(call.authorization, `Bearer ${KEY_VALUE}`);
  assert.ok(
    !JSON.stringify(call.body).includes(KEY_VALUE),
    "the credential appeared in the request body",
  );
  assert.ok(!run.stdout.includes(KEY_VALUE));
  assert.ok(!run.stderr.includes(KEY_VALUE));

  // -- the system prompt came from the temporary prompt directory -----------
  const messages = call.body["messages"] as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, SYSTEM_TEXT);

  // -- the current user message is last, and the configured model was sent --
  const last = messages[messages.length - 1];
  assert.equal(last?.role, "user");
  assert.equal(last?.content, USER_TEXT);
  assert.equal(call.body["model"], "synthetic-configured-model");
  assert.equal(call.body["stream"], false);

  // -- nothing was written beside the configuration -------------------------
  assert.deepEqual((await readdir(dir)).sort(), ["delos.config.json", "prompts"]);

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

// --- bounded failure paths -------------------------------------------------

test("a missing credential variable fails before any request is made", async () => {
  const server = await loopbackProvider((_n, res) => respondOk(res, "unused"));
  const { dir, configPath } = await workspace(server.url);

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {});

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.includes(KEY_NAME));
  assert.equal(server.received.length, 0, "a request was made without a credential");

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("an authentication response becomes a safe non-zero failure", async () => {
  const server = await loopbackProvider((_n, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "PROVIDER-BODY-MUST-NOT-APPEAR" } }));
  });
  const { dir, configPath } = await workspace(server.url);

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
    [KEY_NAME]: KEY_VALUE,
  });

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.length > 0);
  assert.ok(!run.stderr.includes("PROVIDER-BODY-MUST-NOT-APPEAR"));
  assert.ok(!run.stderr.includes(KEY_VALUE));

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a malformed success body becomes a safe non-zero failure", async () => {
  const server = await loopbackProvider((_n, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ unexpected: "shape" }));
  });
  const { dir, configPath } = await workspace(server.url);

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
    [KEY_NAME]: KEY_VALUE,
  });

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.length > 0);

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a provider that never answers hits the configured deadline", async () => {
  const held: ServerResponse[] = [];
  const server = await loopbackProvider((_n, res) => {
    held.push(res); // never answered
  });
  const { dir, configPath } = await workspace(server.url, { timeoutMs: 300 });

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
    [KEY_NAME]: KEY_VALUE,
  });

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.length > 0);

  for (const res of held) res.end();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a missing prompt root fails at startup without a request", async () => {
  const server = await loopbackProvider((_n, res) => respondOk(res, "unused"));
  const { dir, configPath } = await workspace(server.url, {}, { withPrompts: false });

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
    [KEY_NAME]: KEY_VALUE,
  });

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.length > 0);
  assert.equal(server.received.length, 0);

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a provider that stops mid-body fails inside the configured deadline", async () => {
  const stalled: ServerResponse[] = [];
  const server = await loopbackProvider((_n, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Headers and the opening of a body, then silence. A deadline that stopped
    // once headers arrived would never fire here, and the CLI would wait for
    // as long as the socket stayed open.
    res.write('{"model":"synthetic-served","choices":[');
    stalled.push(res);
  });
  const { dir, configPath } = await workspace(server.url, { timeoutMs: 400 });

  try {
    const started = Date.now();
    const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {
      [KEY_NAME]: KEY_VALUE,
    });
    const elapsed = Date.now() - started;

    assert.notEqual(run.code, 0);
    assert.equal(run.stdout, "");
    // The deadline fired at all - which an abort-after-headers design could
    // not have done here - and the CLI returned rather than waiting on the
    // open socket.
    assert.ok(elapsed < WAIT_LIMIT_MS, `the CLI did not fail promptly: ${elapsed} ms`);
    // Reported as a deadline, not as a malformed reply: the body was truthful
    // as far as it went, and the budget is what ran out. The turn service
    // replaces the adapter's diagnostic detail with stable wording, so these
    // two sentences are what actually distinguishes the two cases to a user.
    assert.match(run.stderr, /did not answer before the deadline/);
    assert.ok(
      !run.stderr.includes("does not support"),
      `a stalled body was misreported as an unsupported response: ${run.stderr}`,
    );
    assert.ok(!run.stderr.includes(KEY_VALUE));
  } finally {
    // Runs even when an assertion fails, so a held socket cannot leave the
    // suite hanging on a server that never closes.
    for (const res of stalled) res.end();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- what a failing startup is allowed to print ----------------------------

/** Key-shaped, assembled from fragments, standing in for a pasted credential. */
const PLANTED_CONFIG_VALUE = "sk-" + "planted-into-a-config-file";

test("a malformed configuration never leaks its contents to the real stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delos-e2e-"));
  const configPath = join(dir, "delos.config.json");
  // The mistake this guards: a credential typed into the file instead of into
  // an environment variable, in a document that does not parse. Written
  // unquoted so the parser faults on exactly that value.
  await writeFile(
    configPath,
    `{\n  "schemaVersion": 1,\n  "apiKey": ${PLANTED_CONFIG_VALUE}\n}\n`,
    "utf8",
  );

  const run = await runCliProcess(["--config", configPath, "--once", USER_TEXT], {});

  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.includes("not valid JSON"), "the failure was not explained");
  assert.ok(!run.stderr.includes(PLANTED_CONFIG_VALUE), "the value reached stderr");
  // A ten-character prefix is enough to identify a key, and is what the
  // runtime's own parser message would have carried.
  assert.ok(
    !run.stderr.includes(PLANTED_CONFIG_VALUE.slice(0, 10)),
    "a prefix of the value reached stderr",
  );
  await rm(dir, { recursive: true, force: true });
});

test("an unrecognised startup failure prints a fixed line and nothing else", async () => {
  // Reached through runCli - the same function main.ts calls - because the
  // failure has to be injected, and the real process offers no seam for that.
  // The environment is read through a proxy that throws, which is a genuine
  // path through production code rather than a stubbed error.
  const marker = "UNKNOWN-STARTUP-DETAIL-MUST-NOT-APPEAR";
  const server = await loopbackProvider((_n, res) => respondOk(res, "unused"));
  const { dir, configPath } = await workspace(server.url);

  const err: string[] = [];
  const hostileEnv = new Proxy({} as Record<string, string | undefined>, {
    get(): never {
      throw new Error(marker);
    },
  });

  const code = await runCli(["--config", configPath, "--once", USER_TEXT], {
    streams: {
      stdout: () => undefined,
      stderr: (t) => err.push(t),
      readLine: async () => null,
    },
    env: hostileEnv,
    cwd: dir,
    newId: (prefix) => `${prefix}-1`,
    now: () => "2020-01-01T00:00:00.000Z",
  });

  assert.notEqual(code, 0);
  assert.equal(err.join(""), "Delos could not start.\n");
  assert.equal(server.received.length, 0);

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

// --- interrupt ------------------------------------------------------------
//
// The contract, stated once and tested three ways: the first interrupt ends
// the input wait and lets the normal shutdown path run; an in-flight request
// is NOT cancelled, because the model port has no caller cancellation; a
// second interrupt falls through to the runtime's default termination.

test("an interrupt at the prompt exits under control, not by signal", async () => {
  const server = await loopbackProvider((_n, res) => respondOk(res, "unused"));
  const { dir, configPath } = await workspace(server.url);

  const run = await startCliProcess(["--config", configPath], { [KEY_NAME]: KEY_VALUE });
  await until(() => run.stdout().includes("you>"), () => `stdout was ${run.stdout()}`);

  run.interrupt();
  const { code, signal } = await run.finished;

  // Death by signal would mean the shutdown path never ran at all.
  assert.equal(signal, null, "the process was killed by the signal");
  // 130 is written on the last line of main(), which is reached only after
  // runCli() has returned - and runCli() returns only through the `finally`
  // that closes the runtime. This exit code IS the evidence that cleanup ran.
  assert.equal(code, 130);

  assert.ok(!run.stderr().includes("    at "), `a stack reached stderr: ${run.stderr()}`);
  assert.ok(!run.stderr().includes("Error:"), `an error name reached stderr: ${run.stderr()}`);
  assert.ok(!run.stdout().includes(KEY_VALUE));
  assert.ok(!run.stderr().includes(KEY_VALUE));
  assert.equal(server.received.length, 0);

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("an interrupt during a request lets that request finish first", async () => {
  const held: ServerResponse[] = [];
  const server = await loopbackProvider((_n, res) => held.push(res));
  const { dir, configPath } = await workspace(server.url, { timeoutMs: 10_000 });

  const run = await startCliProcess(["--config", configPath], { [KEY_NAME]: KEY_VALUE });
  await until(() => run.stdout().includes("you>"), () => `stdout was ${run.stdout()}`);
  run.write("A question asked just before the interrupt.\n");
  await until(() => held.length > 0, () => "the provider never received the request");

  run.interrupt();
  // Long enough that a handler which killed the turn would have done so.
  await new Promise((wait) => setTimeout(wait, 200));
  assert.equal(run.stdout().includes("Reply after the interrupt."), false);

  const inFlight = held[0];
  assert.ok(inFlight);
  respondOk(inFlight, "Reply after the interrupt.");

  const { code, signal } = await run.finished;
  assert.equal(signal, null);
  assert.equal(code, 130);
  // The turn was neither abandoned nor reported as failed: it was answered.
  assert.ok(
    run.stdout().includes("Reply after the interrupt."),
    `the in-flight reply was lost: ${run.stdout()}`,
  );
  assert.equal(run.stderr(), "");

  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a second interrupt falls through to the default forced termination", async () => {
  const held: ServerResponse[] = [];
  const server = await loopbackProvider((_n, res) => held.push(res));
  // A deadline far longer than this test: without the escape hatch below the
  // process would wait it out.
  const { dir, configPath } = await workspace(server.url, { timeoutMs: 120_000 });

  const run = await startCliProcess(["--config", configPath], { [KEY_NAME]: KEY_VALUE });
  await until(() => run.stdout().includes("you>"), () => `stdout was ${run.stdout()}`);
  run.write("A question that is never answered.\n");
  await until(() => held.length > 0, () => "the provider never received the request");

  run.interrupt(); // absorbed; the handler removes itself
  await new Promise((wait) => setTimeout(wait, 250));
  run.interrupt(); // the runtime's default handling now applies

  const { code, signal } = await run.finished;
  assert.equal(signal, "SIGINT", "the second interrupt did not terminate the process");
  assert.equal(code, null);

  for (const res of held) res.end();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

// --- interactive, through the injected I/O layer ---------------------------

test("a two-turn interactive conversation carries the first exchange as history", async () => {
  const server = await loopbackProvider((n, res) =>
    respondOk(res, n === 0 ? "Synthetic answer one." : "Synthetic answer two."),
  );
  const { dir, configPath } = await workspace(server.url);

  const out: string[] = [];
  const err: string[] = [];
  const queue = ["Synthetic question one.", "Synthetic question two.", "/exit"];
  let ids = 0;
  const deps: CliDependencies = {
    streams: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readLine: async () => (queue.length > 0 ? (queue.shift() as string) : null),
    },
    env: { [KEY_NAME]: KEY_VALUE },
    cwd: dir,
    newId: (prefix) => `${prefix}-${++ids}`,
    now: () => "2020-01-01T00:00:00.000Z",
  };

  const code = await runCli(["--config", configPath], deps);
  assert.equal(code, 0, err.join(""));

  assert.equal(server.received.length, 2);
  const second = server.received[1]?.body["messages"] as Array<{
    role: string;
    content: string;
  }>;
  assert.deepEqual(
    second.map((m) => `${m.role}:${m.content}`),
    [
      `system:${SYSTEM_TEXT}`,
      "user:Synthetic question one.",
      "assistant:Synthetic answer one.",
      "user:Synthetic question two.",
    ],
  );

  const printed = out.join("");
  assert.ok(printed.includes("Synthetic answer one."));
  assert.ok(printed.includes("Synthetic answer two."));
  assert.ok(!printed.includes(KEY_VALUE));

  await server.close();
  await rm(dir, { recursive: true, force: true });
});
