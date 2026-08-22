/**
 * One place that removes credentials from text.
 *
 * Every provider-facing error, diagnostic and log line passes through here.
 * Centralising it is the point: redaction scattered across adapters is
 * redaction that will be forgotten in exactly one place, and that one place is
 * the one that ends up in a bug report.
 *
 * Two complementary strategies, because either alone is insufficient:
 *
 *   1. **Known values.** Whatever the secret store actually resolved is
 *      replaced wherever it appears. This catches a credential echoed back by
 *      a provider inside a message we never wrote.
 *   2. **Shapes.** `Authorization: Bearer ...`, `x-api-key: ...`, URL
 *      userinfo, and common credential query parameters are matched
 *      structurally, so a value we never saw is still removed.
 */

export const REDACTED = "[redacted]";

/** Header names whose entire value is a credential. */
const SECRET_HEADERS = ["authorization", "x-api-key", "api-key", "proxy-authorization"];

/** Query parameters that conventionally carry a credential. */
const SECRET_QUERY_PARAMS = ["api_key", "apikey", "access_token", "token", "key", "secret"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactorOptions {
  /**
   * Values known to be secret, usually whatever the secret store resolved for
   * this request. Short values are ignored: redacting a 3-character string
   * would blank out unrelated text and make errors unreadable.
   */
  readonly values?: readonly string[];
  /** Extra header names to treat as credential-bearing, e.g. a custom one. */
  readonly headerNames?: readonly string[];
}

export interface Redactor {
  /** Redact a string. */
  text(input: string): string;
  /** Redact anything, structurally, without stringifying secrets on the way. */
  value(input: unknown): unknown;
}

const MIN_REDACTABLE_LENGTH = 8;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const known = (options.values ?? [])
    .filter((v) => typeof v === "string" && v.length >= MIN_REDACTABLE_LENGTH)
    // Longest first, so a token that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);

  const headerNames = [
    ...SECRET_HEADERS,
    ...(options.headerNames ?? []).map((h) => h.toLowerCase()),
  ];

  // Case-insensitive on the NAME, because a provider may echo "X-Api-Key" in
  // any casing; the value is matched to end of line or a quote.
  const headerPatterns = headerNames.map(
    (name) =>
      new RegExp(`(${escapeRegExp(name)}\\s*[:=]\\s*)(?:Bearer\\s+)?["']?[^"'\\n,}]+`, "gi"),
  );

  const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
  const userinfo = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi;
  const queryPatterns = SECRET_QUERY_PARAMS.map(
    (p) => new RegExp(`([?&]${escapeRegExp(p)}=)[^&\\s"']+`, "gi"),
  );

  function text(input: string): string {
    let out = input;
    for (const value of known) {
      out = out.split(value).join(REDACTED);
    }
    for (const pattern of headerPatterns) out = out.replace(pattern, `$1${REDACTED}`);
    out = out.replace(bearer, `Bearer ${REDACTED}`);
    out = out.replace(userinfo, `$1${REDACTED}@`);
    for (const pattern of queryPatterns) out = out.replace(pattern, `$1${REDACTED}`);
    return out;
  }

  /**
   * Walk a structure, redacting strings and dropping credential-bearing keys.
   *
   * Follows `cause` chains, because a wrapped error is exactly where an
   * un-redacted value survives when only the top-level message is cleaned.
   */
  function value(input: unknown, depth = 0): unknown {
    if (depth > 8) return "[truncated]";
    if (typeof input === "string") return text(input);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => value(item, depth + 1));

    if (input instanceof Error) {
      const out: Record<string, unknown> = {
        name: input.name,
        message: text(input.message),
      };
      if (input.cause !== undefined) out["cause"] = value(input.cause, depth + 1);
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      if (headerNames.includes(key.toLowerCase())) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = value(child, depth + 1);
    }
    return out;
  }

  return { text, value: (input: unknown) => value(input, 0) };
}

/** A redactor that knows no specific values but still removes known shapes. */
export const SHAPE_ONLY_REDACTOR: Redactor = createRedactor();
