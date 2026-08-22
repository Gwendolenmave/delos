#!/usr/bin/env node
/**
 * The process entry point.
 *
 * The only file that touches the real process: streams, environment, working
 * directory, identifiers, clock, exit code and the platform application-data
 * directory. Everything it knows about running a conversation lives in
 * `run-cli.ts`, which is why that file is testable without a terminal.
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import { defaultDataDir } from "../../adapters/config/app-data-dir.js";
import type { CliStreams } from "./run-cli.js";

const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature";

function warningType(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (typeof first !== "object" || first === null || !("type" in first)) return undefined;
  const type = (first as { readonly type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Node 22 still labels the built-in `node:sqlite` module experimental. The
 * transcript adapter deliberately uses that built-in to avoid adding a native
 * dependency, but a successful Delos command must not print Node's one-time
 * implementation-status warning as if Delos itself had failed.
 *
 * Keep this extremely narrow: delay the runtime import, suppress only the exact
 * SQLite ExperimentalWarning while that module graph is first loaded, and
 * restore `process.emitWarning` immediately. Every other Node/application
 * warning keeps its normal stderr behaviour.
 */
async function loadRunCli(): Promise<typeof import("./run-cli.js")["runCli"]> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning;
    if (
      message.startsWith(SQLITE_EXPERIMENTAL_WARNING) &&
      warningType(args) === "ExperimentalWarning"
    ) {
      return;
    }
    return Reflect.apply(originalEmitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;

  try {
    const module = await import("./run-cli.js");
    return module.runCli;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function createStreams(): { streams: CliStreams; close: () => void } {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()?.(null);
  });

  const streams: CliStreams = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readLine: () =>
      new Promise<string | null>((resolveLine) => {
        const buffered = lines.shift();
        if (buffered !== undefined) resolveLine(buffered);
        else if (ended) resolveLine(null);
        else waiting.push(resolveLine);
      }),
  };

  // Pausing stdin releases the handle that would otherwise hold the event loop
  // open after the conversation ends, so the process exits on its own instead
  // of needing process.exit() to cut it short.
  return {
    streams,
    close: () => {
      rl.close();
      process.stdin.pause();
    },
  };
}

/** Exit code after an interrupt: 128 + SIGINT, the shell convention. */
const EXIT_INTERRUPTED = 130;

async function main(): Promise<void> {
  const runCli = await loadRunCli();
  const { streams, close } = createStreams();

  let interrupted = false;
  /**
   * The first interrupt stops input and lets runCli unwind through normal
   * cleanup. An in-flight provider request is not claimed cancelled because
   * the model port has no caller-cancellation contract. A second interrupt
   * restores Node's default immediate termination behaviour.
   */
  const onInterrupt = (): void => {
    interrupted = true;
    process.removeListener("SIGINT", onInterrupt);
    close();
  };
  process.on("SIGINT", onInterrupt);

  try {
    const code = await runCli(process.argv.slice(2), {
      streams,
      env: process.env,
      cwd: process.cwd(),
      dataDir: defaultDataDir(process.env),
      newId: (prefix) => `${prefix}-${randomUUID()}`,
      now: () => new Date().toISOString(),
    });
    process.exitCode = interrupted ? EXIT_INTERRUPTED : code;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    close();
  }
}

await main();
