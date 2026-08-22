/**
 * The two OpenAI-shaped protocols.
 *
 * PROTOCOL CHOICE, recorded as required. The official adapter speaks the
 * **Responses API** (`POST /v1/responses`): it is the API OpenAI's current
 * documentation presents as the primary text-generation interface, it carries
 * system-authority content in a dedicated `instructions` field rather than a
 * role convention, and its response shape (typed output items) is less
 * ambiguous to extract than chat-completions choices. The compatible adapter
 * speaks **chat completions** (`POST /chat/completions`), because that is the
 * wire format the local-server and relay ecosystem actually implements.
 *
 * These are therefore genuinely different protocols, which is exactly why an
 * official profile is NOT silently routed through the compatibility path: the
 * request bodies, response shapes and system-content conventions differ, and
 * diagnostics that pretended otherwise would misreport what was on the wire.
 *
 * Neither adapter relies on undocumented response fields: extraction reads
 * `output[].content[].text` / `usage` (Responses) and
 * `choices[0].message.content` / `usage` (chat completions), and anything
 * missing stays unknown rather than guessed.
 */

import type { ProviderProfile } from "../../../core/domain/provider-profile.js";
import type { ModelRequest } from "../../../core/ports/model-provider.js";
import type {
  DelosProvider,
  GenerateOptions,
  ProviderResult,
  ProviderTurn,
  ProviderUsage,
} from "../../../core/ports/provider.js";
import type { Redactor } from "../../../core/services/redaction.js";
import {
  applyAuthTransport,
  defaultFetch,
  joinApiPath,
  postJson,
  ProviderError,
  requestRedactor,
  type FetchLike,
} from "../shared/http-provider-core.js";

export const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";
export const PROTOCOL_OPENAI_RESPONSES = "openai-responses";
export const PROTOCOL_OPENAI_CHAT_COMPLETIONS = "openai-chat-completions";

/** Response-metadata keys allowed out of the adapter. Nothing else survives. */
const METADATA_ALLOWLIST = ["id", "created", "created_at", "finish_reason", "stop_reason", "status"];

export interface OpenAIAdapterOptions {
  readonly profile: ProviderProfile;
  /** Resolved by the registry. Absent only for transport "none". */
  readonly credential?: string;
  readonly fetchImpl?: FetchLike;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of METADATA_ALLOWLIST) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readUsage(body: Record<string, unknown>): ProviderUsage | undefined {
  const usage = body["usage"];
  if (!isRecord(usage)) return undefined;
  const input = usage["input_tokens"] ?? usage["prompt_tokens"];
  const output = usage["output_tokens"] ?? usage["completion_tokens"];
  const result: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof input === "number") result.inputTokens = input;
  if (typeof output === "number") result.outputTokens = output;
  return result.inputTokens !== undefined || result.outputTokens !== undefined
    ? result
    : undefined;
}

function readServedModel(body: Record<string, unknown>): string | undefined {
  const model = body["model"];
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function headersFor(profile: ProviderProfile, credential: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [name, value] of Object.entries(profile.headers ?? {})) headers[name] = value;
  applyAuthTransport(headers, profile.auth, credential);
  return headers;
}

function turnFailure(error: unknown, kind: string, redactor: Redactor): ProviderTurn {
  if (error instanceof ProviderError) return { ok: false, error: error.toFailure() };
  // Unknown throw: nothing from it is trusted, not even the message.
  return {
    ok: false,
    error: new ProviderError(
      "protocol-error",
      kind,
      "The provider exchange failed in an unexpected way.",
      "unknown",
      redactor,
    ).toFailure(),
  };
}

// --- official: Responses API -------------------------------------------------

/**
 * Extract assistant text from a Responses body: the `output` array's message
 * items, their `output_text` content parts, concatenated in order.
 */
function extractResponsesText(body: Record<string, unknown>): string | null {
  const output = body["output"];
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "message") continue;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part["type"] === "output_text" && typeof part["text"] === "string") {
        parts.push(part["text"]);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export function createOpenAIResponsesProvider(options: OpenAIAdapterOptions): DelosProvider {
  const { profile, credential } = options;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const redactor = requestRedactor(credential, profile.auth);
  const baseUrl = profile.baseUrl ?? OPENAI_OFFICIAL_BASE_URL;
  const url = joinApiPath(baseUrl, "/responses");

  return {
    profileId: profile.id,
    kind: profile.kind,
    protocol: PROTOCOL_OPENAI_RESPONSES,

    async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
      const requestedModel = request.model ?? profile.model;
      try {
        const body = await postJson({
          url,
          headers: headersFor(profile, credential),
          body: {
            model: requestedModel,
            // System authority travels in the field the protocol defines for
            // it, never as a pseudo-message.
            instructions: request.systemPrompt,
            input: request.messages.map((m) => ({ role: m.role, content: m.text })),
            // Delos is local-first: the provider is not asked to retain
            // response state. Sent on EVERY request, including connection
            // tests, with no profile switch to turn it off. This does not
            // eliminate the provider's abuse-monitoring retention and does
            // not override the account's own data-control policy.
            store: false,
          },
          timeoutMs: profile.timeoutMs,
          providerKind: profile.kind,
          fetchImpl,
          redactor,
          signal: genOptions?.signal,
        });

        if (!isRecord(body)) {
          throw new ProviderError(
            "malformed-response",
            profile.kind,
            "The provider returned a non-object response body.",
            "unknown",
            redactor,
          );
        }
        const text = extractResponsesText(body);
        if (text === null) {
          throw new ProviderError(
            "malformed-response",
            profile.kind,
            "The response carried no assistant text at output[].content[]. " +
              "This adapter supports text output only.",
            "unknown",
            redactor,
          );
        }

        const servedModel = readServedModel(body);
        const usage = readUsage(body);
        const rawProviderMetadata = pickMetadata(body);
        const result: ProviderResult = {
          text,
          requestedModel,
          ...(servedModel === undefined ? {} : { servedModel }),
          ...(usage === undefined ? {} : { usage }),
          protocol: PROTOCOL_OPENAI_RESPONSES,
          capabilitiesObserved: { cancellation: true },
          ...(rawProviderMetadata === undefined ? {} : { rawProviderMetadata }),
        };
        return { ok: true, result };
      } catch (error) {
        return turnFailure(error, profile.kind, redactor);
      }
    },
  };
}

// --- compatible: chat completions -------------------------------------------

function extractChatCompletionsText(body: Record<string, unknown>): string | null {
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first["message"];
  if (!isRecord(message)) return null;
  const content = message["content"];
  return typeof content === "string" ? content : null;
}

export function createOpenAICompatibleProvider(options: OpenAIAdapterOptions): DelosProvider {
  const { profile, credential } = options;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const redactor = requestRedactor(credential, profile.auth);
  if (profile.baseUrl === undefined) {
    throw new ProviderError(
      "profile-invalid",
      profile.kind,
      "An OpenAI-compatible profile requires baseUrl - there is no official " +
        "default for a compatible endpoint.",
      "no",
      redactor,
    );
  }
  const url = joinApiPath(profile.baseUrl, "/chat/completions");

  return {
    profileId: profile.id,
    kind: profile.kind,
    protocol: PROTOCOL_OPENAI_CHAT_COMPLETIONS,

    async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
      const requestedModel = request.model ?? profile.model;
      try {
        const body = await postJson({
          url,
          headers: headersFor(profile, credential),
          body: {
            model: requestedModel,
            messages: [
              { role: "system", content: request.systemPrompt },
              ...request.messages.map((m) => ({ role: m.role, content: m.text })),
            ],
            stream: false,
          },
          timeoutMs: profile.timeoutMs,
          providerKind: profile.kind,
          fetchImpl,
          redactor,
          signal: genOptions?.signal,
        });

        if (!isRecord(body)) {
          throw new ProviderError(
            "malformed-response",
            profile.kind,
            "The provider returned a non-object response body.",
            "unknown",
            redactor,
          );
        }
        const text = extractChatCompletionsText(body);
        if (text === null) {
          throw new ProviderError(
            "malformed-response",
            profile.kind,
            "The response carried no assistant text at choices[0].message.content.",
            "unknown",
            redactor,
          );
        }

        const servedModel = readServedModel(body);
        const usage = readUsage(body);
        const rawProviderMetadata = pickMetadata(body);
        const result: ProviderResult = {
          text,
          requestedModel,
          ...(servedModel === undefined ? {} : { servedModel }),
          ...(usage === undefined ? {} : { usage }),
          protocol: PROTOCOL_OPENAI_CHAT_COMPLETIONS,
          capabilitiesObserved: { cancellation: true },
          ...(rawProviderMetadata === undefined ? {} : { rawProviderMetadata }),
        };
        return { ok: true, result };
      } catch (error) {
        return turnFailure(error, profile.kind, redactor);
      }
    },
  };
}
