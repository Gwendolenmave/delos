/**
 * OpenAI-compatible model adapter.
 *
 * Translates the provider-neutral `ModelProvider` port into one real wire
 * protocol. It is **one** adapter, not the definition of all future model
 * connectors: a vendor SDK, an OAuth-based account connector, a local runtime
 * or a CLI agent would each be another implementation of the same port.
 *
 * It holds a credential only for the lifetime of the object, receives it from
 * composition rather than reading any file or environment variable itself,
 * and never puts it in an error, a log line, or a fixture.
 */

import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../../../core/ports/model-provider.js";

/** Minimal shape of the response this adapter needs. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** The subset of `fetch` this adapter uses. */
export type FetchLike = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponseLike>;

export interface OpenAICompatibleProviderOptions {
  /** API root, normally ending in `/v1`. Not the chat-completions endpoint. */
  readonly baseUrl: string;
  readonly model: string;
  /** Runtime credential supplied by composition. Absent for no-auth endpoints. */
  readonly apiKey?: string;
  readonly timeoutMs: number;
  /** Defaults to the runtime's global fetch. */
  readonly fetchImpl?: FetchLike;
}

/** Stable, functional provider label. Never a persona name. */
export const PROVIDER_NAME = "openai-compatible";

const CHAT_COMPLETIONS_PATH = "chat/completions";
const ABORTED = Symbol("delos-provider-aborted");

/**
 * Hard-bound an async transport step to an AbortSignal.
 *
 * Native fetch observes AbortSignal itself, but FetchLike is also a public test
 * and embedding seam. A custom implementation that ignores abort must not be
 * able to hold the runtime forever. The underlying operation may continue in
 * its own implementation, but its result is detached and can never be accepted.
 */
function abortBound<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(ABORTED);
      return;
    }

    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      operation().then(finishResolve, finishReject);
    } catch (error) {
      finishReject(error);
    }
  });
}

/** Join the configured API root with the protocol path. */
export function buildChatCompletionsUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return `${baseUrl.slice(0, end)}/${CHAT_COMPLETIONS_PATH}`;
}

interface WireMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the one response shape supported by the v1 adapter. */
function readReplyText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first["message"];
  if (!isRecord(message)) return null;
  const content = message["content"];
  return typeof content === "string" ? content : null;
}

/** Served-model identity, from provider metadata only - never from prose. */
function readServedModel(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const model = body["model"];
  return typeof model === "string" && model.length > 0 ? model : null;
}

function defaultFetch(url: string, init: HttpRequestInit): Promise<HttpResponseLike> {
  // Provider POSTs can carry credentials. Never replay one along a redirect
  // chain: return the 3xx itself and reject it without reading Location/body.
  return fetch(url, { ...init, redirect: "manual" });
}

function deadlineExceeded(timeoutMs: number): ModelResult {
  return {
    ok: false,
    errorKind: "timeout",
    detail: `The provider did not send a complete response within ${timeoutMs} ms.`,
  };
}

function redirectRefused(status: number): ModelResult {
  return {
    ok: false,
    errorKind: "provider_error",
    detail:
      `The provider attempted to redirect the request (HTTP ${status}). ` +
      "Delos does not follow redirects on provider calls; configure the final endpoint directly.",
  };
}

/** Build a provider bound to one endpoint and model. */
export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): ModelProvider {
  const { baseUrl, model, apiKey, timeoutMs } = options;
  const doFetch: FetchLike = options.fetchImpl ?? defaultFetch;

  const configurationProblem =
    baseUrl.trim().length === 0
      ? "no base URL is configured"
      : model.trim().length === 0
        ? "no model is configured"
        : !Number.isInteger(timeoutMs) || timeoutMs <= 0
          ? "the configured timeout is not a positive integer"
          : null;

  const url = configurationProblem === null ? buildChatCompletionsUrl(baseUrl) : "";

  return {
    name: PROVIDER_NAME,

    async generate(request: ModelRequest): Promise<ModelResult> {
      if (configurationProblem !== null) {
        return {
          ok: false,
          errorKind: "configuration",
          detail: `The model provider is not usable: ${configurationProblem}.`,
        };
      }

      const messages: WireMessage[] = [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((m) => ({ role: m.role, content: m.text })),
      ];

      const payload = {
        model: request.model != null ? request.model : model,
        messages,
        stream: false,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey !== undefined && apiKey.length > 0) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      // One hard deadline covers send, status and complete body parsing. The
      // AbortController asks cooperative transports to stop; abortBound also
      // guarantees return if a custom transport ignores that request entirely.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        let response: HttpResponseLike;
        try {
          response = await abortBound(
            () =>
              doFetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
              }),
            controller.signal,
          );
        } catch (error) {
          return timedOut || error === ABORTED
            ? deadlineExceeded(timeoutMs)
            : {
                ok: false,
                errorKind: "network",
                detail: "The provider could not be reached.",
              };
        }

        if (timedOut) return deadlineExceeded(timeoutMs);

        if (response.status >= 300 && response.status < 400) {
          // Deliberately do not inspect Location or body.
          return redirectRefused(response.status);
        }

        if (!response.ok) {
          // The body is not read: a provider error body can contain account
          // identifiers, quota detail, or an echo of the request.
          if (response.status === 401 || response.status === 403) {
            return {
              ok: false,
              errorKind: "authentication",
              detail: `The provider rejected the credential (HTTP ${response.status}).`,
            };
          }
          if (response.status === 429) {
            return {
              ok: false,
              errorKind: "rate_limit",
              detail: `The provider applied a rate limit (HTTP ${response.status}).`,
            };
          }
          return {
            ok: false,
            errorKind: "provider_error",
            detail: `The provider rejected the request (HTTP ${response.status}).`,
          };
        }

        let body: unknown;
        try {
          body = await abortBound(() => response.json(), controller.signal);
        } catch (error) {
          return timedOut || error === ABORTED
            ? deadlineExceeded(timeoutMs)
            : {
                ok: false,
                errorKind: "invalid_response",
                detail:
                  "The provider returned a success status with an unparseable body.",
              };
        }

        if (timedOut) return deadlineExceeded(timeoutMs);

        const text = readReplyText(body);
        if (text === null) {
          return {
            ok: false,
            errorKind: "invalid_response",
            detail:
              "The provider returned a success status with an unsupported response shape. " +
              "This adapter supports a text reply at choices[0].message.content.",
          };
        }

        return { ok: true, text, servedModel: readServedModel(body) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
