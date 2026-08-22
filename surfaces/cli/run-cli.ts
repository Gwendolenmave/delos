/**
 * The reference command-line surface.
 *
 * A surface owns arguments, input and output, and the interactive loop. Durable
 * conversation records live behind the transcript port; provider payloads,
 * prompt loading and reply sanitisation remain below the surface.
 *
 * Everything external is injected - streams, environment, working directory,
 * identifiers, clock and optional data directory - so the whole surface is
 * testable without touching the real process.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  createRuntime,
  describeStartupFailure,
  type DelosRuntime,
  type EnvironmentLike,
  type FetchLike,
} from "../../composition/create-runtime.js";
import { openCliTranscriptSession } from "./transcript-session.js";

const DEFAULT_CONFIG_FILENAME = "delos.config.json";

/** Neutral labels: the persona is content and may be renamed or replaced. */
const USER_LABEL = "you>";
const ASSISTANT_LABEL = "assistant>";

const TRANSCRIPT_OPEN_FAILURE =
  "Delos could not open its local transcript archive. No model request was made.";
const TRANSCRIPT_WRITE_FAILURE =
  "Delos could not durably record the turn. No reply was displayed.";
const TRANSCRIPT_SCOPE_FAILURE =
  "Delos could not establish a stable local transcript scope. No model request was made.";

const HELP_TEXT = `delos - a local, self-hosted assistant

Usage:
  delos [--config <path>]                  start or resume an interactive conversation
  delos [--config <path>] --once <text>    send one message and print the reply
  delos [--config <path>] --test-provider  test the provider and exit
  delos --doctor [--data-dir <p>] [--json] read-only health checks and exit
  delos persona <validate|snapshot|test>   persona integrity tools (see below)
  delos --help                             show this message

Options:
  --config <path>     configuration file (default: ./${DEFAULT_CONFIG_FILENAME})
  --provider <id>     select a provider profile from the configuration
  --once <text>       send exactly one message, print the reply, and exit
  --test-provider     probe the selected provider through its real path
  --help, -h          show this message

--provider and --test-provider need a schemaVersion 2 configuration with
provider profiles; see docs/PROVIDER-PROFILES.md.

Interactive completed turns are stored in Delos's local application-data
directory and resume after a restart. /clear starts a fresh conversation while
preserving the previous transcript; /exit or /quit ends the current process.`;

export interface CliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** One line of input, or null at end of input. */
  readonly readLine: () => Promise<string | null>;
}

export interface CliDependencies {
  readonly streams: CliStreams;
  readonly env: EnvironmentLike;
  readonly cwd: string;
  /** Process-local identifier factory. Injected so tests are deterministic. */
  readonly newId: (prefix: string) => string;
  /** Current time as an ISO-8601 string. */
  readonly now: () => string;
  /** Test/embedding override for the application-data directory. */
  readonly dataDir?: string;
  /** Passed through to the model adapter; production leaves it unset. */
  readonly fetchImpl?: FetchLike;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

interface ParsedArguments {
  readonly help: boolean;
  readonly doctor: boolean;
  readonly doctorJson: boolean;
  readonly dataDir?: string;
  readonly configPath?: string;
  readonly once?: string;
  readonly providerId?: string;
  readonly testProvider: boolean;
}

class UsageError extends Error {}

/** Unknown and duplicate arguments are refused rather than ignored. */
function parseArguments(argv: readonly string[]): ParsedArguments {
  let help = false;
  let doctor = false;
  let doctorJson = false;
  let dataDir: string | undefined;
  let configPath: string | undefined;
  let once: string | undefined;
  let providerId: string | undefined;
  let testProvider = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config") {
      if (configPath !== undefined) throw new UsageError("--config was given more than once");
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--config needs a file path");
      configPath = value;
      continue;
    }
    if (arg === "--once") {
      if (once !== undefined) throw new UsageError("--once was given more than once");
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--once needs a message");
      once = value;
      continue;
    }
    if (arg === "--provider") {
      if (providerId !== undefined) throw new UsageError("--provider was given more than once");
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--provider needs a profile id");
      providerId = value;
      continue;
    }
    if (arg === "--test-provider") {
      if (testProvider) throw new UsageError("--test-provider was given more than once");
      testProvider = true;
      continue;
    }
    if (arg === "--doctor") {
      if (doctor) throw new UsageError("--doctor was given more than once");
      doctor = true;
      continue;
    }
    if (arg === "--json") {
      doctorJson = true;
      continue;
    }
    if (arg === "--data-dir") {
      if (dataDir !== undefined) throw new UsageError("--data-dir was given more than once");
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--data-dir needs a directory path");
      dataDir = value;
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}`);
  }

  if (testProvider && once !== undefined) {
    throw new UsageError("--test-provider and --once cannot be combined");
  }
  if (doctorJson && !doctor) throw new UsageError("--json belongs to --doctor");
  if (dataDir !== undefined && !doctor) throw new UsageError("--data-dir belongs to --doctor");

  return {
    help,
    doctor,
    doctorJson,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(once === undefined ? {} : { once }),
    ...(providerId === undefined ? {} : { providerId }),
    testProvider,
  };
}

/** Exactly one implicit configuration location: ./delos.config.json. */
function resolveConfigPath(parsed: ParsedArguments, cwd: string): string {
  const given = parsed.configPath;
  if (given === undefined) return resolve(cwd, DEFAULT_CONFIG_FILENAME);
  return isAbsolute(given) ? given : resolve(cwd, given);
}

/**
 * Persistent CLI continuity is scoped to the effective runtime configuration.
 *
 * The path alone is not sufficient: one schema-v2 file can select different
 * provider profiles, and a schema-v1 file can be edited in place to point at a
 * different endpoint/model. Reusing the old transcript in either case could
 * forward prior conversation history across a provider boundary.
 *
 * The scope therefore binds the resolved path, the exact validated-startup
 * config bytes observed during this process, and the selected provider's safe
 * runtime identity. Only the digest becomes a directory name; no local path or
 * configuration text is copied into transcript metadata.
 */
function resolveTranscriptDataDir(
  applicationDataDir: string | undefined,
  configPath: string,
  configBytes: Buffer | undefined,
  activeProfile: DelosRuntime["activeProfile"],
): string | undefined {
  if (applicationDataDir === undefined) return undefined;
  if (configBytes === undefined) throw new Error("configuration snapshot unavailable");

  const hash = createHash("sha256");
  hash.update(configPath, "utf8");
  hash.update("\0", "utf8");
  hash.update(configBytes);
  hash.update("\0", "utf8");
  if (activeProfile === undefined) {
    hash.update("inline-provider", "utf8");
  } else {
    hash.update(activeProfile.id, "utf8");
    hash.update("\0", "utf8");
    hash.update(activeProfile.kind, "utf8");
    hash.update("\0", "utf8");
    hash.update(activeProfile.model, "utf8");
  }

  return join(applicationDataDir, "cli", hash.digest("hex").slice(0, 24));
}

async function runOnce(
  runtime: DelosRuntime,
  deps: CliDependencies,
  text: string,
  transcriptDataDir: string | undefined,
): Promise<number> {
  const turnId = deps.newId("turn");

  // Preserve the original blank-input behaviour without creating transcript
  // state for an input that the turn service rejects before any provider call.
  if (text.trim().length === 0) {
    const outcome = await runtime.turnService.runTurn({
      conversationId: deps.newId("conv"),
      turnId,
      history: [],
      userText: text,
      atIso: deps.now(),
    });
    if (!outcome.ok) {
      deps.streams.stderr(`${outcome.failure}\n`);
      return EXIT_FAILURE;
    }
    return EXIT_FAILURE;
  }

  let session;
  try {
    session = await openCliTranscriptSession({
      env: deps.env,
      newId: deps.newId,
      nowIso: deps.now,
      ...(transcriptDataDir === undefined ? {} : { dataDir: transcriptDataDir }),
      oneShot: true,
    });
  } catch {
    deps.streams.stderr(`${TRANSCRIPT_OPEN_FAILURE}\n`);
    return EXIT_FAILURE;
  }

  try {
    try {
      await session.persistUser(turnId, text);
    } catch {
      deps.streams.stderr(`${TRANSCRIPT_WRITE_FAILURE}\n`);
      return EXIT_FAILURE;
    }

    const outcome = await runtime.turnService.runTurn({
      conversationId: session.conversationId,
      turnId,
      history: [],
      userText: text,
      atIso: deps.now(),
    });

    if (!outcome.ok) {
      deps.streams.stderr(`${outcome.failure}\n`);
      return EXIT_FAILURE;
    }

    try {
      await session.persistAssistant(turnId, outcome.replyText);
    } catch {
      deps.streams.stderr(`${TRANSCRIPT_WRITE_FAILURE}\n`);
      return EXIT_FAILURE;
    }

    // Reply is displayed only after durable assistant persistence.
    deps.streams.stdout(`${outcome.replyText}\n`);
    return EXIT_OK;
  } finally {
    await session.close();
  }
}

async function runInteractive(
  runtime: DelosRuntime,
  deps: CliDependencies,
  transcriptDataDir: string | undefined,
): Promise<number> {
  let session;
  try {
    session = await openCliTranscriptSession({
      env: deps.env,
      newId: deps.newId,
      nowIso: deps.now,
      ...(transcriptDataDir === undefined ? {} : { dataDir: transcriptDataDir }),
    });
  } catch {
    deps.streams.stderr(`${TRANSCRIPT_OPEN_FAILURE}\n`);
    return EXIT_FAILURE;
  }

  deps.streams.stdout("Delos. /exit to leave.\n");

  try {
    for (;;) {
      deps.streams.stdout(`${USER_LABEL} `);
      const line = await deps.streams.readLine();
      if (line === null) break;

      const trimmed = line.trim();
      if (trimmed === "/exit" || trimmed === "/quit") break;
      if (trimmed === "/clear") {
        try {
          await session.clear();
        } catch {
          deps.streams.stderr(`${TRANSCRIPT_WRITE_FAILURE}\n`);
          return EXIT_FAILURE;
        }
        deps.streams.stdout("Conversation cleared.\n");
        continue;
      }
      if (trimmed.length === 0) continue;

      const turnId = deps.newId("turn");
      try {
        // User-first durability: if this write fails, the provider is never called.
        await session.persistUser(turnId, line);
      } catch {
        deps.streams.stderr(`${TRANSCRIPT_WRITE_FAILURE}\n`);
        return EXIT_FAILURE;
      }

      const outcome = await runtime.turnService.runTurn({
        conversationId: session.conversationId,
        turnId,
        history: session.history,
        userText: line,
        atIso: deps.now(),
      });

      if (!outcome.ok) {
        // The user record remains as evidence, but restart restoration ignores
        // it because no completed assistant record exists for the same turn.
        deps.streams.stderr(`${outcome.failure}\n`);
        continue;
      }

      try {
        await session.persistAssistant(turnId, outcome.replyText);
      } catch {
        deps.streams.stderr(`${TRANSCRIPT_WRITE_FAILURE}\n`);
        return EXIT_FAILURE;
      }

      deps.streams.stdout(`${ASSISTANT_LABEL} ${outcome.replyText}\n`);
    }
    return EXIT_OK;
  } finally {
    await session.close();
  }
}

/** Run the CLI and return an exit code rather than exiting the process. */
export async function runCli(
  argv: readonly string[],
  deps: CliDependencies,
): Promise<number> {
  if (argv[0] === "persona") {
    const { runPersonaCli } = await import("./persona-cli.js");
    return runPersonaCli(argv.slice(1), {
      stdout: deps.streams.stdout,
      stderr: deps.streams.stderr,
    });
  }

  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "Invalid arguments.";
    deps.streams.stderr(`${message}\n\n${HELP_TEXT}\n`);
    return EXIT_USAGE;
  }

  if (parsed.help) {
    deps.streams.stdout(`${HELP_TEXT}\n`);
    return EXIT_OK;
  }

  if (parsed.doctor) {
    const { runDoctorCli } = await import("./run-doctor.js");
    return runDoctorCli({
      ...(parsed.dataDir === undefined ? {} : { dataDir: parsed.dataDir }),
      json: parsed.doctorJson,
      env: deps.env,
      streams: deps.streams,
      nowIso: deps.now,
    });
  }

  const configPath = resolveConfigPath(parsed, deps.cwd);
  let configSnapshotBefore: Buffer | undefined;
  if (deps.dataDir !== undefined && !parsed.testProvider) {
    try {
      configSnapshotBefore = await readFile(configPath);
    } catch {
      // Composition below owns the safe, typed configuration-file error. Keep
      // this snapshot absent so an invalid/missing config is still reported by
      // the existing startup contract rather than by transcript machinery.
    }
  }

  let runtime: DelosRuntime;
  try {
    runtime = await createRuntime({
      configPath,
      env: deps.env,
      ...(parsed.providerId === undefined ? {} : { providerId: parsed.providerId }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  } catch (error) {
    deps.streams.stderr(`${describeStartupFailure(error)}\n`);
    return EXIT_FAILURE;
  }

  try {
    if (parsed.testProvider) {
      return await runConnectionTest(runtime, deps);
    }

    let transcriptDataDir: string | undefined;
    if (deps.dataDir !== undefined) {
      let configSnapshotAfter: Buffer;
      try {
        configSnapshotAfter = await readFile(configPath);
      } catch {
        deps.streams.stderr(`${TRANSCRIPT_SCOPE_FAILURE}\n`);
        return EXIT_FAILURE;
      }
      if (
        configSnapshotBefore === undefined ||
        !configSnapshotBefore.equals(configSnapshotAfter)
      ) {
        // Fail closed if the file changed while composition was selecting and
        // constructing the provider. The transcript must describe the same
        // configuration the runtime actually started with.
        deps.streams.stderr(`${TRANSCRIPT_SCOPE_FAILURE}\n`);
        return EXIT_FAILURE;
      }
      try {
        transcriptDataDir = resolveTranscriptDataDir(
          deps.dataDir,
          configPath,
          configSnapshotAfter,
          runtime.activeProfile,
        );
      } catch {
        deps.streams.stderr(`${TRANSCRIPT_SCOPE_FAILURE}\n`);
        return EXIT_FAILURE;
      }
    }

    return parsed.once === undefined
      ? await runInteractive(runtime, deps, transcriptDataDir)
      : await runOnce(runtime, deps, parsed.once, transcriptDataDir);
  } finally {
    await runtime.close();
  }
}

/** Probe the active provider and report only safe connection evidence. */
async function runConnectionTest(
  runtime: DelosRuntime,
  deps: CliDependencies,
): Promise<number> {
  if (runtime.testConnection === undefined) {
    deps.streams.stderr(
      "Connection testing needs provider profiles, which need a schemaVersion 2 " +
        "configuration. This configuration is schemaVersion 1.\n",
    );
    return EXIT_FAILURE;
  }

  const active = runtime.activeProfile;
  if (active !== undefined) {
    deps.streams.stdout(`Testing provider "${active.id}" (${active.kind}, model ${active.model})...\n`);
  }

  const report = await runtime.testConnection();
  if (report.ok) {
    deps.streams.stdout(
      `ok: endpoint reachable, request accepted\n` +
        `  requested model  ${report.requestedModel}\n` +
        `  served model     ${report.servedModel ?? "(not evidenced)"}\n` +
        `  protocol         ${report.protocol}\n` +
        `  latency          ${report.latencyMs} ms\n`,
    );
    return EXIT_OK;
  }

  deps.streams.stderr(
    `failed: ${report.error.code}\n` +
      `  ${report.error.message}\n` +
      `  retryable: ${report.error.retryable}` +
      (report.error.httpStatus === undefined ? "" : `, http status ${report.error.httpStatus}`) +
      `\n`,
  );
  return EXIT_FAILURE;
}
