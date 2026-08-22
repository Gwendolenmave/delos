/**
 * The delegated Claude Code provider: the installed `claude` CLI through its
 * official structured non-interactive surface (`--print` with JSON output).
 *
 * Boundaries, all enforced here:
 *
 * - The TOOL owns authentication. Delos never reads a credential file, never
 *   passes a key, never inspects login state beyond what the CLI itself
 *   reports on its official surface. An Anthropic API key and a Claude
 *   subscription login are different authentication modes; this adapter uses
 *   whichever the installed CLI already has and claims neither.
 * - DELOS owns multi-turn history. Every call is a single self-contained
 *   `--print` invocation carrying the assembled system prompt and rendered
 *   history; the CLI's own session store is not used (no --continue, no
 *   --resume).
 * - Ordinary conversation gets NO coding-agent tools: `--max-turns 1` allows
 *   no tool round-trips, and the working directory is a bounded, empty
 *   directory - never the repository, never anything private.
 * - Timeout and cancellation kill the child process.
 *
 * The invocation contract is exercised end to end by a fake `claude`
 * executable in the tests. Against the real CLI the integration is
 * truthfully DEGRADED until observed on an installed supported version.
 */

import type { ModelRequest } from "../../../core/ports/model-provider.js";
import type {
  DelosProvider,
  GenerateOptions,
  ProviderErrorCode,
  ProviderTurn,
  Retryable,
} from "../../../core/ports/provider.js";
import type { ProviderProfile } from "../../../core/domain/provider-profile.js";
import { guardUntrustedText } from "../../../core/services/delimiter-guard.js";
import { runToCompletion, type ProcessRunner } from "./process-runner.js";

export const CLAUDE_CODE_PROTOCOL = "claude-code-print-json";
export const DEFAULT_CLAUDE_COMMAND = "claude";

export interface DelegatedAdapterOptions {
  readonly profile: ProviderProfile;
  /** Injected by tests; production spawns real processes. */
  readonly runner?: ProcessRunner;
  /** Bounded working directory for the child. Required by the daemon. */
  readonly workDir?: string;
}

/**
 * Render the request into one self-contained prompt. Delos owns history.
 *
 * This is TEXTUAL role rendering - the one place where "Assistant:" is a
 * structural delimiter - so every message body passes the delimiter guard:
 * content cannot open a forged role line, close an untrusted block, or
 * impersonate a reasoning tag. The canonical transcript keeps the original.
 */
export function renderConversation(request: ModelRequest): string {
  const lines: string[] = [];
  for (const message of request.messages) {
    const safe = guardUntrustedText(message.text).text;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${safe}`);
  }
  return lines.join("\n\n");
}

interface ClaudePrintResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly modelUsage?: Record<string, unknown>;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
}

export function createClaudeCodeProvider(options: DelegatedAdapterOptions): DelosProvider {
  const { profile } = options;
  const runner = options.runner ?? runToCompletion;
  const command = profile.executablePath ?? DEFAULT_CLAUDE_COMMAND;
  // FAIL CLOSED on a missing bound: falling back to the invoker's working
  // directory would run the child wherever the process happened to start -
  // possibly a repository, possibly somewhere private. No bound, no spawn.
  const workDir = options.workDir;

  function failure(code: ProviderErrorCode, message: string, retryable: Retryable): ProviderTurn {
    return { ok: false, error: { code, providerKind: profile.kind, message, retryable } };
  }

  return {
    profileId: profile.id,
    kind: profile.kind,
    protocol: CLAUDE_CODE_PROTOCOL,

    async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
      if (workDir === undefined) {
        return failure(
          "profile-invalid",
          "The delegated provider has no bounded working directory. The composition must supply one; running in the caller's directory is refused.",
          "no",
        );
      }
      const args = [
        "--print",
        "--output-format",
        "json",
        "--model",
        profile.model,
        "--max-turns",
        "1",
        "--system-prompt",
        request.systemPrompt,
      ];

      const result = await runner(command, {
        args,
        cwd: workDir,
        timeoutMs: profile.timeoutMs,
        stdin: renderConversation(request),
        ...(genOptions?.signal === undefined ? {} : { signal: genOptions.signal }),
      });

      if (result.spawnError === "not-installed") {
        return failure(
          "connection-failed",
          "The claude CLI is not installed or not on PATH. Install Claude Code and sign in with it once; Delos reuses that login.",
          "no",
        );
      }
      if (result.spawnError !== undefined) {
        return failure("connection-failed", "The claude CLI could not be started.", "unknown");
      }
      if (result.timedOut) {
        const cancelled = genOptions?.signal?.aborted === true;
        return failure(
          cancelled ? "cancelled" : "timeout",
          cancelled
            ? "The request was cancelled and the claude process was stopped."
            : "The claude CLI did not answer within the profile timeout and was stopped.",
          cancelled ? "no" : "yes",
        );
      }

      let parsed: ClaudePrintResult;
      try {
        parsed = JSON.parse(result.stdout) as ClaudePrintResult;
      } catch {
        if (result.exitCode !== 0) {
          // Exit-code failure with unparseable output: the commonest cause on
          // a fresh machine is a missing login. Point at the official flow
          // without quoting the tool's raw output, which is not ours to relay.
          return failure(
            "authentication-failed",
            "The claude CLI reported an error before producing a result. If this machine has not signed in, run the CLI's own login once; Delos never handles that credential.",
            "no",
          );
        }
        return failure("malformed-response", "The claude CLI answered with output that was not the documented JSON result.", "unknown");
      }

      if (parsed.is_error === true || result.exitCode !== 0 || typeof parsed.result !== "string") {
        return failure(
          "provider-error",
          "The claude CLI reported an unsuccessful result for this turn.",
          "unknown",
        );
      }

      // servedModel only when the CLI itself evidenced one.
      const servedModel =
        parsed.modelUsage !== undefined ? Object.keys(parsed.modelUsage)[0] : undefined;

      return {
        ok: true,
        result: {
          text: parsed.result,
          requestedModel: profile.model,
          ...(servedModel === undefined ? {} : { servedModel }),
          ...(parsed.usage === undefined
            ? {}
            : {
                usage: {
                  ...(parsed.usage.input_tokens === undefined ? {} : { inputTokens: parsed.usage.input_tokens }),
                  ...(parsed.usage.output_tokens === undefined ? {} : { outputTokens: parsed.usage.output_tokens }),
                },
              }),
          protocol: CLAUDE_CODE_PROTOCOL,
          capabilitiesObserved: {},
        },
      };
    },
  };
}
