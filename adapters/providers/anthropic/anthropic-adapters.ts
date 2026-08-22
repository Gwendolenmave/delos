/**
 * The Anthropic Messages protocol, official and compatible.
 *
 * PROTOCOL FACTS this adapter is built on, all from the documented Messages
 * API: the endpoint is `POST {base}/v1/messages`; the protocol version header
 * `anthropic-version` is required; official authentication is the `x-api-key`
 * header, NOT a bearer token; system content travels in a top-level `system`
 * field and never as a message role; `max_tokens` is REQUIRED; the response
 * carries content as an array of typed blocks whose text lives in
 * `content[].text`; usage arrives as `usage.input_tokens` /
 * `usage.output_tokens`.
 *
 * Because the system-content conventions, auth header and response shapes all
 * differ from OpenAI's, an Anthropic profile is never emulated through the
 * OpenAI adapter - it would misplace system authority and misreport the wire.
 *
 * The compatible variant speaks the same protocol against a caller-supplied
 * base URL with caller-chosen auth transport. The `anthropic-version` header
 * stays managed: a profile may neither remove it nor supply its own value,
 * because a silently altered protocol version changes what every other field
 * means.
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

export const ANTHROPIC_OFFICIAL_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const PROTOCOL_ANTHROPIC_MESSAGES = "anthropic-messages";

/**
 * The Messages API requires max_tokens. This is the adapter's documented
 * default output budget, not a claim about any model's limit.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const METADATA_ALLOWLIST = ["id", "stop_reason", "stop_sequence", "type"];

/** Headers the protocol owns. A profile supplying one is a conflict, not a tweak. */
const MANAGED_HEADERS = new Set(["anthropic-version", "content-type"]);

export interface AnthropicAdapterOptions {
  readonly profile: ProviderProfile;
  readonly credential?: string;
  readonly fetchImpl?: FetchLike;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractText(body: Record<string, unknown>): string | null {
  const content = body["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function readUsage(body: Record<string, unknown>): ProviderUsage | undefined {
  const usage = body["usage"];
  if (!isRecord(usage)) return undefined;
  const result: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage["input_tokens"] === "number") result.inputTokens = usage["input_tokens"];
  if (typeof usage["output_tokens"] === "number") result.outputTokens = usage["output_tokens"];
  return result.inputTokens !== undefined || result.outputTokens !== undefined
    ? result
    : undefined;
}

function pickMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of METADATA_ALLOWLIST) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createAnthropicProvider(options: AnthropicAdapterOptions): DelosProvider {
  const { profile, credential } = options;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const redactor = requestRedactor(credential, profile.auth);

  // Managed headers cannot be supplied by the profile, in either direction.
  for (const name of Object.keys(profile.headers ?? {})) {
    if (MANAGED_HEADERS.has(name.toLowerCase())) {
      throw new ProviderError(
        "profile-invalid",
        profile.kind,
        `The header ${name} is managed by the Anthropic protocol adapter and ` +
          `cannot be supplied by a profile.`,
        "no",
        redactor,
      );
    }
  }

  if (profile.kind === "anthropic-compatible" && profile.baseUrl === undefined) {
    throw new ProviderError(
      "profile-invalid",
      profile.kind,
      "An Anthropic-compatible profile requires baseUrl - there is no " +
        "official default for a compatible endpoint.",
      "no",
      redactor,
    );
  }

  const baseUrl = profile.baseUrl ?? ANTHROPIC_OFFICIAL_BASE_URL;
  const url = joinApiPath(baseUrl, "/v1/messages");

  function headersFor(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    for (const [name, value] of Object.entries(profile.headers ?? {})) headers[name] = value;
    applyAuthTransport(headers, profile.auth, credential);
    return headers;
  }

  return {
    profileId: profile.id,
    kind: profile.kind,
    protocol: PROTOCOL_ANTHROPIC_MESSAGES,

    async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
      const requestedModel = request.model ?? profile.model;
      try {
        const body = await postJson({
          url,
          headers: headersFor(),
          body: {
            model: requestedModel,
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            // System authority travels in the protocol's dedicated field.
            // There is no "system" message role in this protocol, and
            // inventing one would be silently dropped or rejected upstream.
            system: request.systemPrompt,
            messages: request.messages.map((m) => ({ role: m.role, content: m.text })),
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
        const text = extractText(body);
        if (text === null) {
          throw new ProviderError(
            "malformed-response",
            profile.kind,
            "The response carried no text content blocks. This adapter " +
              "supports text output only.",
            "unknown",
            redactor,
          );
        }

        const servedModel =
          typeof body["model"] === "string" && body["model"].length > 0
            ? (body["model"] as string)
            : undefined;
        const usage = readUsage(body);
        const rawProviderMetadata = pickMetadata(body);
        const result: ProviderResult = {
          text,
          requestedModel,
          ...(servedModel === undefined ? {} : { servedModel }),
          ...(usage === undefined ? {} : { usage }),
          protocol: PROTOCOL_ANTHROPIC_MESSAGES,
          capabilitiesObserved: { cancellation: true },
          ...(rawProviderMetadata === undefined ? {} : { rawProviderMetadata }),
        };
        return { ok: true, result };
      } catch (error) {
        if (error instanceof ProviderError) return { ok: false, error: error.toFailure() };
        return {
          ok: false,
          error: new ProviderError(
            "protocol-error",
            profile.kind,
            "The provider exchange failed in an unexpected way.",
            "unknown",
            redactor,
          ).toFailure(),
        };
      }
    },
  };
}
