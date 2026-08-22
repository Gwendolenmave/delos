/**
 * The process boundary for delegated providers.
 *
 * A delegated provider runs an INSTALLED tool (Codex, Claude Code) that owns
 * its own login. Everything the adapters may do to the system funnels through
 * these two primitives, which keeps the security review surface small:
 *
 * - `runToCompletion`: spawn, feed stdin, collect stdout/stderr, enforce a
 *   deadline. Used for one-shot invocations and version detection.
 * - `startStdioSession`: spawn and keep stdio open for line-delimited JSON
 *   exchanges. Used for the Codex app-server protocol.
 *
 * Both spawn WITHOUT a shell, always. The command is a path or a bare name
 *  resolved on PATH; arguments are an array; nothing is ever interpolated
 * into a shell string. The child inherits the parent environment untouched -
 * the delegated tool needs its HOME to find its own login state, and Delos
 * neither reads that state nor filters it. Delos never parses, copies,
 * uploads or checkpoints any tool's credential files; nothing in this module
 * or the adapters above it opens files at all.
 *
 * One testing affordance, honest and inert in production: a command path
 * ending in `.mjs`/`.js` is run through the current Node executable, because
 * the contract-test fakes are Node scripts and Windows cannot exec a
 * shebang. A real `codex` or `claude` binary never matches it.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Spawn-level failure (executable missing), before any exchange. */
  readonly spawnError?: string;
}

export interface RunOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export type ProcessRunner = (command: string, options: RunOptions) => Promise<RunResult>;

const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

function commandAndArgs(command: string, args: readonly string[]): [string, string[]] {
  if (command.endsWith(".mjs") || command.endsWith(".js")) {
    return [process.execPath, [command, ...args]];
  }
  return [command, [...args]];
}

/** The production runner: no shell, capped output, deadline enforced by kill. */
export const runToCompletion: ProcessRunner = (command, options) =>
  new Promise<RunResult>((resolve) => {
    const [file, args] = commandAndArgs(command, options.args);
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: RunResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", () => {
      timedOut = true;
      child.kill("SIGTERM");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        spawnError: error.code === "ENOENT" ? "not-installed" : (error.code ?? "spawn-failed"),
      });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });

export interface StdioSession {
  /** Send one line (a JSON document) to the child's stdin. */
  send(line: string): void;
  /** Resolve the next complete line from stdout, or reject on exit/timeout. */
  nextLine(timeoutMs: number): Promise<string>;
  stop(): Promise<void>;
  readonly spawnError: string | undefined;
}

export type SessionStarter = (
  command: string,
  args: readonly string[],
  cwd: string,
) => StdioSession;

/** The production stdio session over a spawned child, line-framed. */
export const startStdioSession: SessionStarter = (command, args, cwd) => {
  const [file, finalArgs] = commandAndArgs(command, args);
  const child = spawn(file, finalArgs, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });

  let buffer = "";
  const lines: string[] = [];
  const waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  let exited = false;
  let spawnError: string | undefined;

  const drain = () => {
    while (lines.length > 0 && waiters.length > 0) {
      waiters.shift()!.resolve(lines.shift()!);
    }
    if (exited) {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(spawnError ?? "The delegated process exited."));
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      if (line.length > 0) lines.push(line);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    drain();
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnError = error.code === "ENOENT" ? "not-installed" : (error.code ?? "spawn-failed");
    exited = true;
    drain();
  });
  child.on("close", () => {
    exited = true;
    drain();
  });

  return {
    get spawnError() {
      return spawnError;
    },
    send(line: string) {
      child.stdin.write(line + "\n");
    },
    nextLine(timeoutMs: number) {
      return new Promise<string>((resolve, reject) => {
        if (lines.length > 0) {
          resolve(lines.shift()!);
          return;
        }
        if (exited) {
          reject(new Error(spawnError ?? "The delegated process exited."));
          return;
        }
        const timer = setTimeout(() => {
          const at = waiters.findIndex((w) => w.resolve === wrapped.resolve);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error("Timed out waiting for the delegated process."));
        }, timeoutMs);
        const wrapped = {
          resolve: (line: string) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiters.push(wrapped);
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        child.once("close", () => resolve());
        child.stdin.end();
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000).unref();
      });
    },
  };
};

export interface DetectionReport {
  readonly installed: boolean;
  /** First line of `--version`, trimmed. Never an account identifier. */
  readonly version?: string;
  readonly detail: string;
}

/** `<tool> --version`: installed or not, and which version. Nothing else. */
export async function detectExecutable(
  runner: ProcessRunner,
  command: string,
  cwd: string,
): Promise<DetectionReport> {
  const result = await runner(command, { args: ["--version"], cwd, timeoutMs: 10_000 });
  if (result.spawnError === "not-installed") {
    return { installed: false, detail: `${command} is not installed or not on PATH.` };
  }
  if (result.spawnError !== undefined) {
    return { installed: false, detail: `${command} could not be started (${result.spawnError}).` };
  }
  if (result.timedOut || result.exitCode !== 0) {
    return {
      installed: true,
      detail: `${command} started but did not answer --version cleanly.`,
    };
  }
  const version = result.stdout.trim().split("\n")[0] ?? "";
  return { installed: true, version, detail: `${command} answered --version.` };
}
