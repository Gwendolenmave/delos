/**
 * The delegated Codex provider: the installed `codex` CLI through its
 * official `codex app-server` stdio surface - line-delimited JSON-RPC.
 *
 * The protocol subset used here is deliberately minimal and version-gated:
 * `initialize`, `getAuthStatus`, `newConversation`, `sendUserMessage`, and
 * the event notifications that carry the agent's reply. Nothing undocumented
 * is guessed at: if the installed version does not answer the handshake the
 * adapter reports a clear unsupported-version error instead of probing, and
 * a version without `getAuthStatus` degrades to letting the turn surface
 * auth problems rather than failing.
 *
 * Authentication belongs to Codex. The tool persists and refreshes its own
 * ChatGPT-managed login; Delos never parses, copies, rewrites, uploads or
 * checkpoints its auth files, and never asks for a token. Ordinary
 * conversation requests no tools.
 *
 * Codex is NOT installed on the development host. The contract below is
 * exercised end to end against a fake `codex` executable; the real
 * integration is truthfully DEGRADED until observed on an installed
 * supported version, and the status surface says exactly that.
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
import { startStdioSession, type SessionStarter } from "./process-runner.js";
import { renderConversation } from "./claude-code-provider.js";

export const CODEX_PROTOCOL = "codex-app-server-jsonrpc";
export const DEFAULT_CODEX_COMMAND = "codex";

export interface CodexAdapterOptions {
  readonly profile: ProviderProfile;
  /** Injected by tests; production spawns the real app-server. */
  readonly startSession?: SessionStarter;
  readonly workDir?: string;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { code?: number; message?: string };
}

export interface CodexAuthInspection {
  /** False when the installed version does not answer the auth method. */
  readonly supported: boolean;
  readonly authenticated?: boolean;
  /** Safe for doctor output: no account identifier, no token. */
  readonly detail: string;
}

/**
 * Inspect Codex auth state through the OFFICIAL app-server surface, for
 * doctor's explicit online mode. Read-only: initialize + getAuthStatus,
 * then stop. Never reads a file, never triggers a login.
 */
export async function inspectCodexAuth(
  profile: ProviderProfile,
  options: { startSession?: SessionStarter; workDir: string },
): Promise<CodexAuthInspection> {
  const start = options.startSession ?? startStdioSession;
  const command = profile.executablePath ?? DEFAULT_CODEX_COMMAND;
  const session = start(command, ["app-server"], options.workDir);
  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    for (;;) {
      const line = await session.nextLine(10_000);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (message.id === id) {
        if (message.error !== undefined) throw new Error(message.error.message ?? "rpc error");
        return message.result ?? {};
      }
    }
  };
  try {
    if (session.spawnError === "not-installed") {
      return { supported: false, detail: "codex is not installed or not on PATH." };
    }
    await call("initialize", { clientInfo: { name: "delos", title: "Delos", version: "0.1.0-dev" } });
    let auth: Record<string, unknown>;
    try {
      auth = await call("getAuthStatus", {});
    } catch {
      return {
        supported: false,
        detail: "This codex version does not answer the auth-status method; auth surfaces per turn instead.",
      };
    }
    const authenticated = auth["authenticated"] === true || typeof auth["method"] === "string";
    return {
      supported: true,
      authenticated,
      detail: authenticated
        ? "Signed in (reported by the official surface; no account identifier read)."
        : "Not signed in. Run the codex CLI's own login once; Delos never handles that credential.",
    };
  } catch {
    return { supported: false, detail: "The codex app-server did not answer the handshake." };
  } finally {
    await session.stop();
  }
}

export function createCodexProvider(options: CodexAdapterOptions): DelosProvider {
  const { profile } = options;
  const start = options.startSession ?? startStdioSession;
  const command = profile.executablePath ?? DEFAULT_CODEX_COMMAND;
  // FAIL CLOSED on a missing bound - see claude-code-provider.ts. No bound,
  // no spawn.
  const workDir = options.workDir;

  function failure(code: ProviderErrorCode, message: string, retryable: Retryable): ProviderTurn {
    return { ok: false, error: { code, providerKind: profile.kind, message, retryable } };
  }

  return {
    profileId: profile.id,
    kind: profile.kind,
    protocol: CODEX_PROTOCOL,

    async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
      if (workDir === undefined) {
        return failure(
          "profile-invalid",
          "The delegated provider has no bounded working directory. The composition must supply one; running in the caller's directory is refused.",
          "no",
        );
      }
      const session = start(command, ["app-server"], workDir);
      const deadline = Date.now() + profile.timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      let nextId = 1;

      const call = async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        const id = nextId++;
        session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        // Read until OUR response id; notifications in between are ignored
        // here and handled by the turn loop below where they matter.
        for (;;) {
          if (genOptions?.signal?.aborted === true) throw new Error("cancelled");
          const line = await session.nextLine(remaining());
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue; // non-JSON noise on stdout is not ours to interpret
          }
          if (message.id === id) {
            if (message.error !== undefined) {
              throw new Error(`rpc:${method}:${message.error.message ?? "error"}`);
            }
            return message.result ?? {};
          }
        }
      };

      try {
        if (session.spawnError === "not-installed") {
          return failure(
            "connection-failed",
            "The codex CLI is not installed or not on PATH. Install Codex and sign in with it once; Delos reuses that login.",
            "no",
          );
        }

        let initialized: Record<string, unknown>;
        try {
          initialized = await call("initialize", {
            clientInfo: { name: "delos", title: "Delos", version: "0.1.0-dev" },
          });
        } catch (error) {
          if (session.spawnError === "not-installed") {
            return failure(
              "connection-failed",
              "The codex CLI is not installed or not on PATH. Install Codex and sign in with it once; Delos reuses that login.",
              "no",
            );
          }
          return failure(
            "protocol-error",
            "The installed codex version did not answer the app-server handshake Delos understands. It may be older or newer than the supported protocol.",
            "no",
          );
        }

        // Account/auth state through the OFFICIAL surface - never through
        // files. An unauthenticated codex is routed to its own documented
        // login flow; Delos launches nothing and holds nothing. A version
        // that does not answer this method is not failed for it - the turn
        // itself will surface any auth problem.
        try {
          const auth = await call("getAuthStatus", {});
          const authenticated = auth["authenticated"] === true || typeof auth["method"] === "string";
          if (!authenticated) {
            return failure(
              "authentication-failed",
              "Codex is installed but not signed in. Run the codex CLI's own login once; Delos reuses that login and never handles the credential.",
              "no",
            );
          }
        } catch (error) {
          if (error instanceof Error && error.message === "cancelled") throw error;
          // Auth-state inspection unsupported on this version: proceed.
        }

        const conversation = await call("newConversation", {
          // The tightest confinement this official surface exposes for
          // ordinary conversation, stated honestly: approvalPolicy "never"
          // AUTO-APPROVES rather than disables the built-in exec tool, and
          // the read-only sandbox bounds WRITES to nothing while reads
          // remain OS-wide - the app-server protocol offers no full
          // tool-disable switch. The optional plan/apply-patch tools are
          // explicitly excluded; the exec tool remaining is a stated
          // limitation, not a met requirement.
          cwd: workDir,
          approvalPolicy: "never",
          sandbox: "read-only",
          includePlanTool: false,
          includeApplyPatchTool: false,
        });
        const conversationId = conversation["conversationId"];
        if (typeof conversationId !== "string") {
          return failure(
            "protocol-error",
            "The codex app-server did not return a conversation id in the documented shape.",
            "no",
          );
        }

        // The system prompt travels as instructions text at the head of the
        // rendered conversation: Delos owns history, and every turn is a
        // fresh conversation with the full transcript rendered in.
        const prompt = `${request.systemPrompt}\n\n${renderConversation(request)}`;
        await call("sendUserMessage", {
          conversationId,
          items: [{ type: "text", data: { text: prompt } }],
        });

        // Collect agent output events until the turn completes.
        let text = "";
        for (;;) {
          if (genOptions?.signal?.aborted === true) {
            return failure("cancelled", "The request was cancelled and the codex process was stopped.", "no");
          }
          const line = await session.nextLine(remaining());
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue;
          }
          if (message.method === "codex/event/agent_message") {
            const value = (message.params?.["msg"] as { message?: string } | undefined)?.message;
            if (typeof value === "string") text += value;
          } else if (message.method === "codex/event/task_complete") {
            break;
          } else if (message.method === "codex/event/error") {
            return failure(
              "provider-error",
              "Codex reported an error for this turn.",
              "unknown",
            );
          }
        }

        if (text.length === 0) {
          return failure(
            "malformed-response",
            "The codex turn completed without an agent message.",
            "unknown",
          );
        }

        const served = initialized["userAgent"];
        return {
          ok: true,
          result: {
            text,
            requestedModel: profile.model,
            protocol: CODEX_PROTOCOL,
            capabilitiesObserved: {},
            ...(typeof served === "string" ? { rawProviderMetadata: { userAgent: served } } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "cancelled") {
          return failure("cancelled", "The request was cancelled and the codex process was stopped.", "no");
        }
        if (message.startsWith("Timed out")) {
          return failure("timeout", "Codex did not answer within the profile timeout and was stopped.", "yes");
        }
        return failure(
          "connection-failed",
          "The codex app-server exchange failed before a result arrived.",
          "unknown",
        );
      } finally {
        await session.stop();
      }
    },
  };
}
