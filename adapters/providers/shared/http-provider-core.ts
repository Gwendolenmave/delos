/**
 * The transport spine shared by the four HTTP provider adapters.
 *
 * Each adapter owns its PROTOCOL - request body shape, response extraction,
 * required headers. None of them owns transport concerns, because four copies
 * of deadline handling is how one of them ends up subtly wrong. This module
 * owns:
 *
 *   - one deadline covering send, status, body read and parse;
 *   - caller cancellation, composed with the deadline;
 *   - auth placement from the profile's transport;
 *   - the safe-error contract, with redaction applied before anything leaves;
 *   - URL joining that never duplicates a path segment.
 *
 * It deliberately does NOT interpret response bodies - that is protocol.
 */

import type { ProviderAuth } from "../../../core/domain/provider-profile.js";
import type {
  ProviderErrorCode,
  ProviderFailure,
  Retryable,
} from "../../../core/ports/provider.js";
import { createRedactor, type Redactor } from "../../../core/services/redaction.js";

const ABORTED = Symbol("delos-http-provider-aborted");

/**
 * Hard-bound one async transport step to an AbortSignal.
 *
 * Native fetch cooperates with AbortSignal, but FetchLike is also an embedding
 * seam. A custom transport that ignores abort must not be able to pin the host
 * forever. Once detached, a late result can never be accepted by Delos.
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

/** The safe error. Everything in it may be shown to a user. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly providerKind: string,
    safeMessage: string,
    readonly retryable: Retryable,
    redactor: Redactor,
    readonly httpStatus?: number,
  ) {
    super(redactor.text(safeMessage));
    this.name = "ProviderError";
  }

  toFailure(): ProviderFailure {
    return {
      code: this.code,
      providerKind: this.providerKind,
      message: this.message,
      retryable: this.retryable,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
    };
  }
}

/** Map an HTTP status to the public category. */
export function categoriseStatus(status: number): {
  code: ProviderErrorCode;
  retryable: Retryable;
} {
  if (status === 401) return { code: "authentication-failed", retryable: "no" };
  if (status === 403) return { code: "permission-denied", retryable: "no" };
  if (status === 404) return { code: "model-not-found", retryable: "no" };
  if (status === 429) return { code: "rate-limited", retryable: "yes" };
  if (status >= 500) return { code: "provider-error", retryable: "yes" };
  return { code: "provider-error", retryable: "unknown" };
}

/** Minimal response shape, injectable for tests. */
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

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export function defaultFetch(url: string, init: HttpRequestInit): Promise<HttpResponseLike> {
  // Provider requests carry credentials, so a credential-bearing POST must
  // never be replayed along a redirect chain. The 3xx itself is rejected by
  // postJson without reading Location or body.
  return fetch(url, { ...init, redirect: "manual" });
}

/** Join an API root and a protocol path without doubled boundary slashes. */
export function joinApiPath(baseUrl: string, path: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end--;
  return baseUrl.slice(0, end) + (path.startsWith("/") ? path : `/${path}`);
}

/** Place a resolved credential according to the profile's transport. */
export function applyAuthTransport(
  headers: Record<string, string>,
  auth: ProviderAuth,
  credential: string | undefined,
): void {
  if (auth.transport === "none") return;
  if (credential === undefined) return;
  if (auth.transport === "bearer") headers["Authorization"] = `Bearer ${credential}`;
  else if (auth.transport === "x-api-key") headers["x-api-key"] = credential;
  else if (auth.transport === "custom-header" && auth.headerName !== undefined) {
    headers[auth.headerName] = credential;
  }
}

export interface HttpExchangeOptions {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
  readonly providerKind: string;
  readonly fetchImpl: FetchLike;
  readonly redactor: Redactor;
  /** Caller cancellation, composed with the deadline. */
  readonly signal?: AbortSignal | undefined;
}

/** One POST exchange under one hard deadline. */
export async function postJson(options: HttpExchangeOptions): Promise<unknown> {
  const { url, timeoutMs, providerKind, fetchImpl, redactor } = options;

  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => {
    callerCancelled = true;
    controller.abort();
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) onCallerAbort();
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const abortError = (): ProviderError =>
    callerCancelled
      ? new ProviderError("cancelled", providerKind, "The request was cancelled.", "no", redactor)
      : new ProviderError(
          "timeout",
          providerKind,
          `The provider did not send a complete response within ${timeoutMs} ms.`,
          "yes",
          redactor,
        );

  try {
    let response: HttpResponseLike;
    try {
      response = await abortBound(
        () =>
          fetchImpl(url, {
            method: "POST",
            headers: options.headers,
            body: JSON.stringify(options.body),
            signal: controller.signal,
          }),
        controller.signal,
      );
    } catch (error) {
      // The thrown transport error is not inspected: it may carry resolved
      // URLs, proxy detail or request metadata.
      if (error === ABORTED || timedOut || callerCancelled) throw abortError();
      throw new ProviderError(
        "connection-failed",
        providerKind,
        "The provider could not be reached.",
        "unknown",
        redactor,
      );
    }

    if (timedOut || callerCancelled) throw abortError();

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError(
        "protocol-error",
        providerKind,
        "The provider attempted to redirect the request. Delos does not " +
          "follow redirects on credential-bearing calls; configure the " +
          "final endpoint directly.",
        "no",
        redactor,
        response.status,
      );
    }

    if (!response.ok) {
      const { code, retryable } = categoriseStatus(response.status);
      // Provider error bodies are deliberately not read.
      throw new ProviderError(
        code,
        providerKind,
        code === "authentication-failed"
          ? "The provider rejected the credential."
          : code === "permission-denied"
            ? "The provider refused access for this credential."
            : code === "model-not-found"
              ? "The provider does not recognise the requested model or path."
              : code === "rate-limited"
                ? "The provider applied a rate limit."
                : `The provider rejected the request (HTTP ${response.status}).`,
        retryable,
        redactor,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await abortBound(() => response.json(), controller.signal);
    } catch (error) {
      if (error === ABORTED || timedOut || callerCancelled) throw abortError();
      throw new ProviderError(
        "malformed-response",
        providerKind,
        "The provider returned a success status with an unparseable body.",
        "unknown",
        redactor,
      );
    }

    if (timedOut || callerCancelled) throw abortError();
    return body;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Build the redactor for one request: resolved credential + custom header. */
export function requestRedactor(
  credential: string | undefined,
  auth: ProviderAuth,
): Redactor {
  return createRedactor({
    values: credential === undefined ? [] : [credential],
    headerNames: auth.headerName === undefined ? [] : [auth.headerName],
  });
}
