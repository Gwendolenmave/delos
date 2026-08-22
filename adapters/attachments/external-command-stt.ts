/**
 * The external-command STT adapter: speech-to-text through a LOCAL command
 * the user installed (whisper.cpp, vosk wrappers, anything that prints a
 * transcript to stdout). No external service is contacted by default, and
 * none is required - without a configured command, voice input is
 * truthfully unsupported.
 *
 * The command is spawned without a shell through the same process boundary
 * the delegated providers use; the audio file path is appended as the last
 * argument. Stdout is the transcript; a non-zero exit or timeout is an
 * honest failure that never relays raw tool output.
 */

import type { SttAdapter } from "../../core/ports/attachment.js";
import { runToCompletion, type ProcessRunner } from "../providers/delegated/process-runner.js";

export interface ExternalCommandSttOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Bounded working directory for the child. */
  readonly workDir: string;
  readonly runner?: ProcessRunner;
}

export function createExternalCommandStt(options: ExternalCommandSttOptions): SttAdapter {
  const runner = options.runner ?? runToCompletion;
  return {
    name: `external-command:${options.command.split(/[\\/]/).pop() ?? options.command}`,
    async transcribe(audioPath, { timeoutMs }) {
      const result = await runner(options.command, {
        args: [...(options.args ?? []), audioPath],
        cwd: options.workDir,
        timeoutMs,
      });
      if (result.spawnError === "not-installed") {
        return { ok: false, text: "The configured transcriber command is not installed or not on PATH." };
      }
      if (result.spawnError !== undefined) {
        return { ok: false, text: "The configured transcriber could not be started." };
      }
      if (result.timedOut) {
        return { ok: false, text: "The transcriber did not finish in time and was stopped." };
      }
      if (result.exitCode !== 0) {
        return { ok: false, text: "The transcriber reported an error for this audio." };
      }
      const text = result.stdout.trim();
      if (text.length === 0) {
        return { ok: false, text: "The transcriber produced no text for this audio." };
      }
      return { ok: true, text };
    },
  };
}
