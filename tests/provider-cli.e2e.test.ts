/**
 * Provider profiles through the real compiled CLI - end to end.
 *
 * Covers the Wave 7a acceptance scenarios: no-auth compatible (7a-A), official
 * OpenAI contract (7a-B), official Anthropic contract (7a-C), compatible
 * custom-header auth with a provider that echoes request metadata (7a-D), and
 * two concurrent profiles that must not cross (7a-E).
 *
 * Every server is a node:http loopback created per test; every credential is
 * synthetic and assembled from fragments. No external host is contacted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { runCli as runCliInProcess, type CliDependencies } from "../surfaces/cli/run-cli.js";
import type { FetchLike } from "../composition/create-runtime.js";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "surfaces", "cli", "main.js");

/**
 * The synthetic official seam, as the review ruling requires: an injected
 * fetchImpl that RECORDS the official URL the adapter actually built and
 * routes the request to an in-test handler. The profile carries no endpoint
 * override - officially-kinded profiles cannot express one - and nothing
 * about this seam is reachable from configuration.
 */
function officialSeam(
  handler: (url: string, headers: Record<string, string>, body: Record<string, unknown>) => {
    status: number;
    body: unknown;
  },
): { fetchImpl: FetchLike; calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] } {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const out = handler(url, call.headers, call.body);
    return { ok: out.status < 300, status: out.status, json: async () => out.body };
  };
  return { fetchImpl, calls };
}

function inProcessDeps(
  fetchImpl: FetchLike,
  env: Record<string, string>,
): { deps: CliDependencies; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  let idCounter = 0;
  return {
    out,
    err,
    deps: {
      streams: {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        readLine: async () => null,
      },
      env,
      cwd: "/",
      // Transcript persistence creates more than one row per turn. Keep the
      // deterministic fixture while preserving the identifier-factory contract.
      newId: (p) => `${p}-${++idCounter}`,
      now: () => "2020-01-01T00:00:00.000Z",
      fetchImpl,
    },
  };
}

const OPENAI_KEY = "sk-" + "synthetic-e2e-openai-key";
const ANTHROPIC_KEY = "sk-ant-" + "synthetic-e2e-key";
const GATEWAY_KEY = "gw-" + "opaque-synthetic-token";

interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface Loopback {
  origin: string;
  received: Captured[];
  close(): Promise<void>;
}

async function loopback(
  handler: (call: Captured, res: ServerResponse) => void,
): Promise<Loopback> {
  const received: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const call: Captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      received.push(call);
      handler(call, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const responsesBody = (text: string) => ({
  id: "resp-1",
  model: "served-official-model",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 3, output_tokens: 2 },
});

const chatBody = (text: string) => ({
  model: "served-compat-model",
  choices: [{ message: { role: "assistant", content: text } }],
});

const anthropicBody = (text: string) => ({
  id: "msg-1",
  model: "served-anthropic-model",
  content: [{ type: "text", text }],
  usage: { input_tokens: 4, output_tokens: 2 },
});

async function workspace(providers: unknown[], defaultProvider?: string) {
  const dir = await mkdtemp(join(tmpdir(), "delos-7a-"));
  await mkdir(join(dir, "prompts"));
  await writeFile(join(dir, "prompts", "identity.md"), "You are a synthetic scenario persona.\n", "utf8");
  const configPath = join(dir, "delos.config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        promptRoot: "./prompts",
        providers,
        ...(defaultProvider === undefined ? {} : { defaultProvider }),
        recentWindow: { maxEstimatedTokens: 4000 },
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, configPath };
}

function runCli(args: readonly string[], env: Record<string, string>) {
  const configIndex = args.indexOf("--config");
  const configPath = configIndex < 0 ? undefined : args[configIndex + 1];
  const testDataDir = configPath === undefined ? undefined : join(dirname(configPath), ".delos-data");
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(testDataDir === undefined ? {} : { DELOS_DATA_DIR: testDataDir }),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

  // A leaked child process must fail this test file instead of keeping the
  // entire repository verification alive until the outer workflow timeout.
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
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

// --- scenario 7a-A: OpenAI-compatible, no auth ------------------------------

test("7a-A: a no-auth compatible profile completes a conversation with model metadata", async () => {
  const server = await loopback((_call, res) => json(res, 200, chatBody("No-auth reply.")));
  const { dir, configPath } = await workspace([
    {
      schemaVersion: 1,
      id: "local",
      kind: "openai-compatible",
      model: "local-model",
      baseUrl: `${server.origin}/v1`,
      auth: { transport: "none" },
    },
  ]);

  try {
    const run = await runCli(["--config", configPath, "--once", "Scenario A probe."], {});
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "No-auth reply.\n");
    assert.equal(server.received[0]?.url, "/v1/chat/completions");
    assert.equal(server.received[0]?.headers["authorization"], undefined);

    // requested vs served model metadata, through --test-provider
    const probe = await runCli(["--config", configPath, "--test-provider"], {});
    assert.equal(probe.code, 0, probe.stderr);
    assert.match(probe.stdout, /requested model\s+local-model/);
    assert.match(probe.stdout, /served model\s+served-compat-model/);
    assert.match(probe.stdout, /protocol\s+openai-chat-completions/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scenario 7a-B: official OpenAI contract --------------------------------

test("7a-B: the official profile speaks the Responses protocol and never leaks the key", async () => {
  // No baseUrl: an official profile cannot express one. The seam records the
  // URL the adapter built and serves the request internally.
  const providers = [
    {
      schemaVersion: 1,
      id: "openai-official",
      kind: "openai",
      model: "official-model",
      auth: { transport: "bearer", source: "environment", envVar: "OPENAI_API_KEY" },
    },
  ];
  const { dir, configPath } = await workspace(providers);

  const seam = officialSeam((_url, headers, _body) =>
    headers["Authorization"] === `Bearer ${OPENAI_KEY}`
      ? { status: 200, body: responsesBody("Official reply.") }
      : { status: 401, body: { error: { message: `denied for ${headers["Authorization"]}` } } },
  );

  try {
    const ok = inProcessDeps(seam.fetchImpl, { OPENAI_API_KEY: OPENAI_KEY });
    const code = await runCliInProcess(["--config", configPath, "--once", "Scenario B probe."], ok.deps);
    assert.equal(code, 0, ok.err.join(""));
    assert.equal(ok.out.join(""), "Official reply.\n");

    const call = seam.calls[0]!;
    assert.equal(call.url, "https://api.openai.com/v1/responses",
      "the adapter dialled the OFFICIAL endpoint - no profile could redirect it");
    assert.equal(call.body["store"], false, "store:false on every ordinary request");
    assert.equal(typeof call.body["instructions"], "string");
    assert.ok(!JSON.stringify(call.body).includes(OPENAI_KEY));
    assert.ok(!ok.out.join("").includes(OPENAI_KEY) && !ok.err.join("").includes(OPENAI_KEY));

    // connection test also carries store:false
    const probe = inProcessDeps(seam.fetchImpl, { OPENAI_API_KEY: OPENAI_KEY });
    const probeCode = await runCliInProcess(["--config", configPath, "--test-provider"], probe.deps);
    assert.equal(probeCode, 0, probe.err.join(""));
    assert.equal(seam.calls[seam.calls.length - 1]!.body["store"], false,
      "store:false on the connection test too");

    // authentication failure: redacted, safe, non-zero
    const wrong = "sk-" + "wrong-synthetic-key";
    const bad = inProcessDeps(seam.fetchImpl, { OPENAI_API_KEY: wrong });
    const badCode = await runCliInProcess(["--config", configPath, "--once", "x"], bad.deps);
    assert.notEqual(badCode, 0);
    assert.ok(!bad.err.join("").includes(wrong), "the wrong key leaked into stderr");

    // missing credential: failed before any request, naming the variable
    const before = seam.calls.length;
    const missing = inProcessDeps(seam.fetchImpl, {});
    const missCode = await runCliInProcess(["--config", configPath, "--once", "x"], missing.deps);
    assert.notEqual(missCode, 0);
    assert.equal(seam.calls.length, before, "a request was made without a credential");
    assert.ok(missing.err.join("").includes("OPENAI_API_KEY"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scenario 7a-C: official Anthropic contract ------------------------------

test("7a-C: the Anthropic profile separates system content and extracts blocks", async () => {
  const providers = [
    {
      schemaVersion: 1,
      id: "anthropic-official",
      kind: "anthropic",
      model: "anthropic-model",
      auth: { transport: "x-api-key", source: "environment", envVar: "ANTHROPIC_API_KEY" },
    },
  ];
  const { dir, configPath } = await workspace(providers);

  const seam = officialSeam((_url, headers) =>
    headers["x-api-key"] === ANTHROPIC_KEY
      ? { status: 200, body: anthropicBody("Anthropic reply.") }
      : { status: 401, body: { error: { type: "authentication_error" } } },
  );

  try {
    const run = inProcessDeps(seam.fetchImpl, { ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const code = await runCliInProcess(["--config", configPath, "--once", "Scenario C probe."], run.deps);
    assert.equal(code, 0, run.err.join(""));
    assert.equal(run.out.join(""), "Anthropic reply.\n");

    const call = seam.calls[0]!;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages",
      "the adapter dialled the OFFICIAL endpoint");
    assert.equal(call.headers["x-api-key"], ANTHROPIC_KEY);
    assert.equal(call.headers["Authorization"], undefined, "official Anthropic is not bearer");
    assert.equal(typeof call.headers["anthropic-version"], "string");
    assert.equal(typeof call.body["system"], "string", "system is a top-level field");
    assert.equal(typeof call.body["max_tokens"], "number");
    assert.ok(!("store" in call.body), "store is an OpenAI Responses field, not Messages");
    const messages = call.body["messages"] as Array<{ role: string }>;
    assert.ok(messages.every((m) => m.role !== "system"), "no system role in this protocol");
    assert.ok(!run.out.join("").includes(ANTHROPIC_KEY) && !run.err.join("").includes(ANTHROPIC_KEY));

    const probe = inProcessDeps(seam.fetchImpl, { ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const probeCode = await runCliInProcess(["--config", configPath, "--test-provider"], probe.deps);
    assert.equal(probeCode, 0, probe.err.join(""));
    assert.match(probe.out.join(""), /served model\s+served-anthropic-model/);
    assert.match(probe.out.join(""), /protocol\s+anthropic-messages/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- redirect containment ----------------------------------------------------

test("credential-bearing requests refuse every redirect status, end to end", async () => {
  // Target server: records anything that reaches it. It must stay silent.
  const target = await loopback((_c, res) => json(res, 200, chatBody("MUST-NEVER-BE-SEEN")));

  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const origin = await loopback((_c, res) => {
        res.writeHead(status, { Location: `${target.origin}/v1/chat/completions` });
        res.end();
      });
      const { dir, configPath } = await workspace([
        {
          schemaVersion: 1,
          id: "redirecting",
          kind: "openai-compatible",
          model: "m",
          baseUrl: `${origin.origin}/v1`,
          auth: { transport: "bearer", source: "environment", envVar: "REDIR_TOKEN" },
        },
      ]);

      try {
        // Real child process, real fetch: this proves the production transport.
        const run = await runCli(["--config", configPath, "--once", "probe"], {
          REDIR_TOKEN: GATEWAY_KEY,
        });
        assert.notEqual(run.code, 0, `status ${status} was followed`);
        assert.ok(!run.stdout.includes("MUST-NEVER-BE-SEEN"), `status ${status}: body from target`);
        assert.ok(!run.stderr.includes(GATEWAY_KEY), `status ${status}: credential in stderr`);
        assert.ok(!run.stderr.includes(target.origin), `status ${status}: target URL surfaced`);
        assert.equal(origin.received.length, 1, `status ${status}: origin saw the request`);
        assert.equal(target.received.length, 0, `status ${status}: target received a request`);
      } finally {
        await origin.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await target.close();
  }
});

// --- scenario 7a-D: custom secret header, hostile error --------------------

test("7a-D: a provider error echoing request metadata is redacted before surfacing", async () => {
  const server = await loopback((call, res) =>
    // A hostile-ish relay: its error body echoes the auth header back.
    json(res, 500, {
      error: {
        message: `internal failure while handling x-gateway-auth: ${String(
          call.headers["x-gateway-auth"],
        )}`,
        echoed_headers: call.headers,
      },
    }),
  );
  const { dir, configPath } = await workspace([
    {
      schemaVersion: 1,
      id: "gateway",
      kind: "openai-compatible",
      model: "gw-model",
      baseUrl: `${server.origin}/v1`,
      auth: {
        transport: "custom-header",
        source: "environment",
        envVar: "GATEWAY_TOKEN",
        headerName: "X-Gateway-Auth",
      },
    },
  ]);

  try {
    const run = await runCli(["--config", configPath, "--once", "Scenario D probe."], {
      GATEWAY_TOKEN: GATEWAY_KEY,
    });
    assert.notEqual(run.code, 0);
    // The credential was genuinely sent...
    assert.equal(server.received[0]?.headers["x-gateway-auth"], GATEWAY_KEY);
    // ...and genuinely echoed by the provider...
    // ...but appears nowhere in what the user sees.
    assert.ok(!run.stdout.includes(GATEWAY_KEY), "credential leaked to stdout");
    assert.ok(!run.stderr.includes(GATEWAY_KEY), "credential leaked to stderr");

    const probe = await runCli(["--config", configPath, "--test-provider"], {
      GATEWAY_TOKEN: GATEWAY_KEY,
    });
    assert.notEqual(probe.code, 0);
    assert.ok(!probe.stderr.includes(GATEWAY_KEY), "credential leaked through the test report");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scenario 7a-E: concurrent profiles do not cross -------------------------

test("7a-E: two profiles run concurrently without credentials or protocols crossing", async () => {
  const openaiServer = await loopback((_c, res) => json(res, 200, chatBody("From the compat side.")));
  const anthropicServer = await loopback((_c, res) => json(res, 200, anthropicBody("From the anthropic side.")));

  const providers = [
    {
      schemaVersion: 1,
      id: "compat-a",
      kind: "openai-compatible",
      model: "model-a",
      baseUrl: `${openaiServer.origin}/v1`,
      auth: { transport: "bearer", source: "environment", envVar: "TOKEN_A" },
    },
    {
      schemaVersion: 1,
      id: "gateway-b",
      kind: "anthropic-compatible",
      model: "model-b",
      baseUrl: anthropicServer.origin,
      auth: { transport: "x-api-key", source: "environment", envVar: "TOKEN_B" },
    },
  ];
  const { dir, configPath } = await workspace(providers, "compat-a");

  const tokenA = "token-" + "a-synthetic-000001";
  const tokenB = "token-" + "b-synthetic-000002";

  try {
    const [runA, runB] = await Promise.all([
      runCli(["--config", configPath, "--provider", "compat-a", "--once", "To A."], {
        TOKEN_A: tokenA,
        TOKEN_B: tokenB,
      }),
      runCli(["--config", configPath, "--provider", "gateway-b", "--once", "To B."], {
        TOKEN_A: tokenA,
        TOKEN_B: tokenB,
      }),
    ]);

    assert.equal(runA.code, 0, runA.stderr);
    assert.equal(runB.code, 0, runB.stderr);
    assert.equal(runA.stdout, "From the compat side.\n");
    assert.equal(runB.stdout, "From the anthropic side.\n");

    // Each server saw exactly its own credential under its own transport.
    const a = openaiServer.received[0]!;
    const b = anthropicServer.received[0]!;
    assert.equal(a.headers["authorization"], `Bearer ${tokenA}`);
    assert.equal(a.headers["x-api-key"], undefined);
    assert.ok(!JSON.stringify(a.headers).includes(tokenB), "token B crossed to server A");
    assert.equal(b.headers["x-api-key"], tokenB);
    assert.equal(b.headers["authorization"], undefined);
    assert.ok(!JSON.stringify(b.headers).includes(tokenA), "token A crossed to server B");

    // Protocols did not cross either.
    assert.ok("messages" in a.body && !("system" in a.body), "A spoke chat-completions");
    assert.ok("system" in b.body && "max_tokens" in b.body, "B spoke anthropic-messages");
  } finally {
    await openaiServer.close();
    await anthropicServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- v1/v2 seam -------------------------------------------------------------

test("a v1 configuration still works, and --provider against it fails usefully", async () => {
  const server = await loopback((_c, res) => json(res, 200, chatBody("v1 still works.")));
  const dir = await mkdtemp(join(tmpdir(), "delos-7a-v1-"));
  await mkdir(join(dir, "prompts"));
  await writeFile(join(dir, "prompts", "identity.md"), "You are a synthetic persona.\n", "utf8");
  const configPath = join(dir, "delos.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      promptRoot: "./prompts",
      provider: {
        kind: "openai-compatible",
        baseUrl: `${server.origin}/v1`,
        model: "v1-model",
      },
      recentWindow: { maxEstimatedTokens: 4000 },
    }),
    "utf8",
  );

  try {
    const run = await runCli(["--config", configPath, "--once", "hello v1"], {});
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "v1 still works.\n");

    const flag = await runCli(["--config", configPath, "--provider", "x", "--once", "y"], {});
    assert.notEqual(flag.code, 0);
    assert.ok(flag.stderr.includes("schemaVersion 2"), "the failure explains what is needed");

    const probe = await runCli(["--config", configPath, "--test-provider"], {});
    assert.notEqual(probe.code, 0);
    assert.ok(probe.stderr.includes("schemaVersion 2"));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});