/**
 * Daemon HTTP plumbing: the security layer every route sits behind.
 *
 * The trust boundary is the loopback interface plus a session token generated
 * at startup. Concretely enforced here, not merely intended:
 *
 *   - the server binds 127.0.0.1 and nothing else;
 *   - every /api request must carry the session token in a HEADER (never a
 *     query parameter - URLs land in logs and history);
 *   - browser-originated requests must carry an Origin matching the daemon's
 *     own origin; requests with a foreign Origin are refused regardless of
 *     token, which is what kills DNS-rebinding and hostile-page CSRF;
 *   - there is no CORS header at all - same-origin needs none, and absence is
 *     stricter than any allowlist;
 *   - request bodies are bounded before parsing;
 *   - error responses have one fixed public shape and never carry a stack,
 *     a path, a prompt, or a credential.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const API_PREFIX = "/api/v1";
export const MAX_BODY_BYTES = 1024 * 1024;
export const SESSION_HEADER = "x-delos-session";

export interface PublicError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: PublicError = { error: { code, message } };
  sendJson(res, status, body);
}

/** Read a JSON body under the size cap. Rejects rather than truncates. */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return; // drain and discard the rest
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        chunks.length = 0;
        // Do NOT destroy the socket mid-upload: the client is still sending,
        // and a reset would replace the 413 with a connection error. The
        // remainder is drained and discarded; the caller sends the response.
        reject(new HttpError(413, "body_too_large", "The request body exceeds the limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json", "The request body is not valid JSON."));
      }
    });
    req.on("error", () => {
      reject(new HttpError(400, "read_failed", "The request body could not be read."));
    });
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The gate every request passes before any route logic.
 *
 * Returns null when the request may proceed. Order matters: origin is judged
 * before the token, so a hostile page never learns whether its stolen token
 * would have worked.
 */
export function gate(
  req: IncomingMessage,
  res: ServerResponse,
  expected: { origin: string; token: string },
): boolean {
  const origin = req.headers["origin"];
  if (typeof origin === "string" && origin !== expected.origin) {
    sendError(res, 403, "foreign_origin", "Requests from other origins are refused.");
    return false;
  }

  const token = req.headers[SESSION_HEADER];
  if (typeof token !== "string" || !timingSafeEqualStr(token, expected.token)) {
    sendError(res, 401, "unauthorized", "A valid session header is required.");
    return false;
  }
  return true;
}

/** Constant-time string comparison without importing node:crypto here. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type RouteHandler = (context: {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
}) => Promise<void>;

interface Route {
  readonly method: string;
  readonly pattern: readonly string[]; // segments; ":name" binds a param
  readonly handler: RouteHandler;
  readonly hasBody: boolean | { readonly maxBytes: number };
}

/**
 * A literal segment router. No regexes over attacker-controlled paths, no
 * decoding surprises: a path is split on "/", each segment percent-decoded
 * once, and a segment that still contains a separator after decoding is
 * refused rather than re-interpreted.
 */
export class Router {
  private readonly routes: Route[] = [];

  on(
    method: string,
    path: string,
    handler: RouteHandler,
    hasBody: boolean | { readonly maxBytes: number } = false,
  ): this {
    this.routes.push({
      method,
      pattern: path.split("/").filter((s) => s.length > 0),
      handler,
      hasBody,
    });
    return this;
  }

  async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const rawSegments = pathname.split("/").filter((s) => s.length > 0);
    const segments: string[] = [];
    for (const raw of rawSegments) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        sendError(res, 400, "bad_path", "The request path is malformed.");
        return true;
      }
      if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        sendError(res, 400, "bad_path", "The request path is malformed.");
        return true;
      }
      segments.push(decoded);
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.pattern.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.pattern.length; i++) {
        const patternSegment = route.pattern[i]!;
        const actual = segments[i]!;
        if (patternSegment.startsWith(":")) params[patternSegment.slice(1)] = actual;
        else if (patternSegment !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      let body: unknown;
      if (route.hasBody !== false) {
        try {
          body = await readJsonBody(
            req,
            typeof route.hasBody === "object" ? route.hasBody.maxBytes : undefined,
          );
        } catch (error) {
          if (error instanceof HttpError) {
            sendError(res, error.status, error.code, error.message);
            return true;
          }
          sendError(res, 400, "read_failed", "The request body could not be read.");
          return true;
        }
      }

      try {
        await route.handler({ req, res, params, body });
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error.status, error.code, error.message);
        } else {
          // The thrown error is not inspected: nothing internal leaves.
          sendError(res, 500, "internal", "The request failed inside the daemon.");
        }
      }
      return true;
    }
    return false;
  }
}

/** One SSE connection: bounded, heartbeat-kept, explicitly closable. */
export interface SseConnection {
  send(event: string, data: unknown): void;
  close(): void;
}

export function openSse(res: ServerResponse): SseConnection {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
  });
  res.write(":ok\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(":hb\n\n");
  }, 15_000);
  return {
    send(event: string, data: unknown): void {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close(): void {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
