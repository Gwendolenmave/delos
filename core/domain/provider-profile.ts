/**
 * A provider profile: everything needed to reach a provider, except the
 * credential.
 *
 * The whole point of the shape is that a profile is a **non-secret document**.
 * It can be committed, pasted into a bug report, exported, or synced, because
 * the only thing it says about a credential is *where to look for one*. That
 * property is enforced here, not merely documented: a profile carrying
 * anything that looks like a credential value is refused.
 *
 * Authentication is split into two independent questions, because conflating
 * them is what produces configuration nobody can reason about:
 *
 *   source     - where the credential is stored (environment, secret store)
 *   transport  - how it is placed on the request (bearer, x-api-key, header)
 *
 * A relay may want an environment-stored credential sent as `X-Api-Key`; an
 * official provider wants a secret-store credential sent as a bearer token.
 * Neither combination is special, and neither needs its own profile kind.
 */

/** The protocols v0.1 speaks. */
export const PROVIDER_KINDS = [
  /** Official OpenAI, official base, official protocol. */
  "openai",
  /** Anything speaking the OpenAI chat-completions wire format. */
  "openai-compatible",
  /** Official Anthropic Messages. */
  "anthropic",
  /** Anything speaking the Anthropic Messages wire format. */
  "anthropic-compatible",
  /**
   * The installed Codex CLI through its official app-server stdio surface.
   * The TOOL owns authentication - a ChatGPT-managed login it persists and
   * refreshes itself. Delos holds no credential for it, ever.
   */
  "delegated-codex",
  /**
   * The installed Claude Code CLI through its official structured
   * non-interactive surface. Same rule: the tool owns its login. An
   * Anthropic API key and a Claude subscription login are DIFFERENT
   * authentication modes; this kind is the second and never claims the
   * first.
   */
  "delegated-claude-code",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isDelegatedKind(kind: ProviderKind): boolean {
  return kind === "delegated-codex" || kind === "delegated-claude-code";
}

/** Where the credential lives. */
export const AUTH_SOURCES = ["environment", "secret-store", "none"] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

/** How the credential is placed on the request. */
export const AUTH_TRANSPORTS = ["bearer", "x-api-key", "custom-header", "none"] as const;
export type AuthTransport = (typeof AUTH_TRANSPORTS)[number];

export const SUPPORTED_PROFILE_SCHEMA_VERSION = 1 as const;

/** Documented bounds. Outside these a timeout is a mistake, not a preference. */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ProviderAuth {
  readonly source: AuthSource;
  readonly transport: AuthTransport;
  /**
   * Reference, never a value. Required when the source is "secret-store";
   * derived as `env:<VARIABLE>` when the source is "environment".
   */
  readonly secretId?: string;
  /** The variable to read. Required when the source is "environment". */
  readonly envVar?: string;
  /** Required when transport is "custom-header". */
  readonly headerName?: string;
}

export interface ProviderProfile {
  readonly schemaVersion: typeof SUPPORTED_PROFILE_SCHEMA_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly model: string;
  /**
   * API ROOT, not an endpoint. Absent for official kinds, which have one.
   * The adapter appends whatever path its protocol needs.
   */
  readonly baseUrl?: string;
  readonly auth: ProviderAuth;
  readonly timeoutMs: number;
  /** Non-secret headers only; validated against a forbidden list. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Delegated kinds only: the executable to run, either a bare command name
   * resolved on PATH or an absolute path. Never a shell string - it is
   * spawned argument-safe with no shell involved.
   */
  readonly executablePath?: string;
  /**
   * No-silent-fallback: when true, a turn must EVIDENCE the requested model.
   * A reply that names a different served model - or names none - fails
   * with "model-mismatch" instead of being silently accepted.
   */
  readonly pinModel?: boolean;
  readonly enabled: boolean;
}

export type ProfileErrorCode =
  | "schema_unsupported"
  | "field_invalid"
  | "credential_in_profile"
  | "url_invalid"
  | "header_invalid"
  | "duplicate_id";

export class ProviderProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ProviderProfileError";
  }
}

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Header names a caller may never set.
 *
 * Two groups. Framing headers (`host`, `content-length`, `connection`,
 * transfer/upgrade) belong to the HTTP layer, and letting a profile override
 * them turns a configuration field into a request-smuggling primitive.
 * Auth headers are excluded separately below, because whether they are
 * forbidden depends on the profile's own transport.
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "expect",
]);

/** Headers the adapters manage themselves. */
const AUTH_HEADERS = new Set(["authorization", "x-api-key"]);

/** RFC 7230 token, i.e. what a header name is actually allowed to be. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Fields that would be a credential rather than a reference.
 *
 * A profile is refused outright if it carries one. This is the rule that keeps
 * the document shareable, so it is checked structurally rather than trusted.
 */
const CREDENTIAL_FIELDS = new Set([
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "bearer",
  "credential",
  "authtoken",
  "auth_token",
  "accesstoken",
  "access_token",
]);

function fail(code: ProfileErrorCode, message: string, field?: string): never {
  throw new ProviderProfileError(code, message, field);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string") fail("field_invalid", `${field} must be a string`, field);
  if (v.trim().length === 0) fail("field_invalid", `${field} must not be empty`, field);
  return v;
}

/**
 * Refuse a profile that carries a credential anywhere in its document.
 *
 * Recursive and key-name based: a user pasting `"apiKey": "..."` into any
 * nesting level gets a clear refusal rather than a profile that silently works
 * and then leaks when exported.
 */
function rejectCredentialFields(value: unknown, path = ""): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const normalised = key.toLowerCase().replace(/[^a-z_]/g, "");
    // secretId is a reference and is explicitly allowed; nothing else named
    // like a credential is.
    if (key !== "secretId" && CREDENTIAL_FIELDS.has(normalised)) {
      fail(
        "credential_in_profile",
        `A provider profile must not contain a credential value. Remove ` +
          `"${here}" and reference a stored secret with auth.secretId instead.`,
        here,
      );
    }
    rejectCredentialFields(child, here);
  }
}

/**
 * Validate an API root.
 *
 * Userinfo is refused because a credential in a URL leaks into logs, proxies,
 * referrers and error messages, and because it defeats the whole
 * profile-carries-no-secret property.
 */
function parseBaseUrl(raw: unknown, field: string): string {
  const text = requireString(raw, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail("url_invalid", `${field} must be an absolute URL`, field);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("url_invalid", `${field} must use http or https`, field);
  }
  if (url.username !== "" || url.password !== "") {
    fail(
      "credential_in_profile",
      `${field} must not embed a username or password. Reference a stored ` +
        `secret with auth.secretId instead.`,
      field,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    fail("url_invalid", `${field} must not carry a query string or fragment`, field);
  }
  return text;
}

function parseAuth(raw: unknown): ProviderAuth {
  if (!isRecord(raw)) fail("field_invalid", "auth must be an object", "auth");

  const transport = requireString(raw["transport"], "auth.transport") as AuthTransport;
  if (!(AUTH_TRANSPORTS as readonly string[]).includes(transport)) {
    fail(
      "field_invalid",
      `auth.transport must be one of: ${AUTH_TRANSPORTS.join(", ")}`,
      "auth.transport",
    );
  }

  // Source defaults to none for an unauthenticated endpoint, and to
  // secret-store otherwise, so the common cases need no boilerplate.
  const source = (raw["source"] === undefined
    ? transport === "none"
      ? "none"
      : "secret-store"
    : requireString(raw["source"], "auth.source")) as AuthSource;
  if (!(AUTH_SOURCES as readonly string[]).includes(source)) {
    fail("field_invalid", `auth.source must be one of: ${AUTH_SOURCES.join(", ")}`, "auth.source");
  }

  if ((transport === "none") !== (source === "none")) {
    fail(
      "field_invalid",
      `auth.transport "none" and auth.source "none" must be used together: ` +
        `an endpoint either needs a credential or it does not.`,
      "auth",
    );
  }

  let secretId: string | undefined;
  let envVar: string | undefined;
  if (source === "environment") {
    // The variable is the configuration; the reference is derived from it, so
    // an environment-backed profile needs exactly one line of auth config.
    envVar = requireString(raw["envVar"], "auth.envVar");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
      fail(
        "field_invalid",
        `auth.envVar must be an environment variable name`,
        "auth.envVar",
      );
    }
    secretId =
      raw["secretId"] === undefined
        ? `env:${envVar}`
        : requireString(raw["secretId"], "auth.secretId");
  } else if (source === "secret-store") {
    secretId = requireString(raw["secretId"], "auth.secretId");
    if (raw["envVar"] !== undefined) {
      fail(
        "field_invalid",
        `auth.envVar applies only when auth.source is "environment"`,
        "auth.envVar",
      );
    }
  } else if (raw["secretId"] !== undefined) {
    fail(
      "field_invalid",
      `auth.secretId is meaningless when auth.source is "none"`,
      "auth.secretId",
    );
  }

  let headerName: string | undefined;
  if (transport === "custom-header") {
    headerName = requireString(raw["headerName"], "auth.headerName");
    if (!HEADER_NAME.test(headerName)) {
      fail(
        "header_invalid",
        `auth.headerName must be a valid HTTP header name (no spaces or ` +
          `control characters)`,
        "auth.headerName",
      );
    }
    if (FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
      fail("header_invalid", `auth.headerName must not be ${headerName}`, "auth.headerName");
    }
  } else if (raw["headerName"] !== undefined) {
    fail(
      "field_invalid",
      `auth.headerName applies only when auth.transport is "custom-header"`,
      "auth.headerName",
    );
  }

  return {
    source,
    transport,
    ...(secretId === undefined ? {} : { secretId }),
    ...(envVar === undefined ? {} : { envVar }),
    ...(headerName === undefined ? {} : { headerName }),
  };
}

function parseHeaders(
  raw: unknown,
  auth: ProviderAuth,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail("field_invalid", "headers must be an object", "headers");

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const field = `headers.${name}`;
    if (!HEADER_NAME.test(name)) {
      fail("header_invalid", `${field} is not a valid header name`, field);
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) {
      fail(
        "header_invalid",
        `${field} is managed by the HTTP layer and must not be set by a profile`,
        field,
      );
    }
    // An auth header may only be supplied when the profile has explicitly
    // chosen custom-header transport under that exact name. Otherwise a
    // "harmless extra header" could silently replace managed authentication.
    if (AUTH_HEADERS.has(lower) || lower === auth.headerName?.toLowerCase()) {
      const owned =
        auth.transport === "custom-header" && auth.headerName?.toLowerCase() === lower;
      if (!owned) {
        fail(
          "header_invalid",
          `${field} carries authentication, which this profile manages ` +
            `itself. Use auth.transport "custom-header" if you need to send ` +
            `a credential under your own header name.`,
          field,
        );
      }
      fail(
        "header_invalid",
        `${field} duplicates the header named by auth.headerName. The ` +
          `credential is supplied from the secret store, not from headers.`,
        field,
      );
    }
    if (typeof value !== "string") {
      fail("field_invalid", `${field} must be a string`, field);
    }
    // CR, LF and NUL in a header value are how header injection happens; the
    // rest of C0 plus DEL go with them because none has a legitimate use in
    // a header. Checked by code point rather than a regex literal so this
    // file itself contains no control bytes.
    const hasControl = [...value].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    if (hasControl) {
      fail("header_invalid", `${field} must not contain control characters`, field);
    }
    out[name] = value;
  }
  return Object.freeze(out);
}

/** Official kinds have an official root and do not take a user-supplied one. */
export function requiresBaseUrl(kind: ProviderKind): boolean {
  return kind === "openai-compatible" || kind === "anthropic-compatible";
}

/**
 * Validate one profile document.
 *
 * Everything cheap fails before anything is constructed, so a rejected profile
 * never half-configures a provider.
 */
export function parseProviderProfile(document: unknown): ProviderProfile {
  if (!isRecord(document)) fail("field_invalid", "A provider profile must be an object");

  const version = document["schemaVersion"];
  if (version !== SUPPORTED_PROFILE_SCHEMA_VERSION) {
    fail(
      "schema_unsupported",
      `Unsupported provider-profile schemaVersion ${String(version)}. This ` +
        `build understands version ${SUPPORTED_PROFILE_SCHEMA_VERSION} only.`,
      "schemaVersion",
    );
  }

  rejectCredentialFields(document);

  const id = requireString(document["id"], "id");
  if (!PROFILE_ID.test(id)) {
    fail(
      "field_invalid",
      `id must be lowercase letters, digits and hyphens, starting with a ` +
        `letter or digit, at most 64 characters`,
      "id",
    );
  }

  const kind = requireString(document["kind"], "kind") as ProviderKind;
  if (!(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    fail("field_invalid", `kind must be one of: ${PROVIDER_KINDS.join(", ")}`, "kind");
  }

  const displayName =
    document["displayName"] === undefined ? id : requireString(document["displayName"], "displayName");
  const model = requireString(document["model"], "model");

  // An OFFICIAL kind is a claim, and the profile must not be able to make it
  // falsely. "openai" and "anthropic" mean: the official endpoint, the
  // official authentication shape, and a real credential. A profile wanting a
  // different endpoint or transport is a COMPATIBLE profile and says so -
  // otherwise a profile labelled official could send an official credential
  // to an arbitrary host, which defeats the public distinction entirely.
  const OFFICIAL: Record<string, { transport: AuthTransport; envVar: string }> = {
    openai: { transport: "bearer", envVar: "OPENAI_API_KEY" },
    anthropic: { transport: "x-api-key", envVar: "ANTHROPIC_API_KEY" },
  };
  const official = OFFICIAL[kind];

  let auth: ProviderAuth;
  if (official !== undefined && document["auth"] === undefined) {
    // The zero-configuration official profile: environment-backed, official
    // transport, conventional variable.
    auth = {
      source: "environment",
      transport: official.transport,
      secretId: `env:${official.envVar}`,
      envVar: official.envVar,
    };
  } else if (isDelegatedKind(kind) && document["auth"] === undefined) {
    // The zero-configuration delegated profile: the tool authenticates, so
    // the only truthful auth is none at all.
    auth = { source: "none", transport: "none" };
  } else {
    auth = parseAuth(document["auth"]);
  }

  if (official !== undefined) {
    if (document["baseUrl"] !== undefined) {
      fail(
        "field_invalid",
        `An official "${kind}" profile uses the official endpoint and must ` +
          `not set baseUrl. Use kind "${kind}-compatible" for a different ` +
          `endpoint.`,
        "baseUrl",
      );
    }
    if (auth.transport !== official.transport) {
      fail(
        "field_invalid",
        `An official "${kind}" profile authenticates with ` +
          `"${official.transport}" - that is the official protocol's shape. ` +
          `Use kind "${kind}-compatible" for other transports.`,
        "auth.transport",
      );
    }
    if (auth.source === "none") {
      fail(
        "field_invalid",
        `An official "${kind}" profile requires a credential.`,
        "auth.source",
      );
    }
  }

  // A DELEGATED kind is also a claim: the installed tool owns login, so the
  // profile must not be able to carry a credential, an endpoint, or headers
  // for it. Anything else would quietly turn "the tool authenticates" into
  // "Delos holds a secret", which is the exact boundary this kind exists to
  // keep.
  let executablePath: string | undefined;
  if (isDelegatedKind(kind)) {
    if (document["baseUrl"] !== undefined) {
      fail("field_invalid", `A "${kind}" profile talks to a local executable and must not set baseUrl.`, "baseUrl");
    }
    if (document["headers"] !== undefined) {
      fail("field_invalid", `A "${kind}" profile sends no HTTP requests and must not set headers.`, "headers");
    }
    if (auth.source !== "none" || auth.transport !== "none") {
      fail(
        "field_invalid",
        `A "${kind}" profile must use auth source "none": the delegated tool ` +
          `owns its own login, and Delos never holds a credential for it.`,
        "auth",
      );
    }
    if (document["executablePath"] !== undefined) {
      executablePath = requireString(document["executablePath"], "executablePath");
      if (executablePath.length === 0 || /[\0\r\n]/.test(executablePath)) {
        fail("field_invalid", "executablePath must be a plain path with no control characters", "executablePath");
      }
    }
  } else if (document["executablePath"] !== undefined) {
    fail("field_invalid", "executablePath is only valid on delegated kinds", "executablePath");
  }

  let baseUrl: string | undefined;
  if (requiresBaseUrl(kind)) {
    baseUrl = parseBaseUrl(document["baseUrl"], "baseUrl");
  }

  const timeoutMs =
    document["timeoutMs"] === undefined ? DEFAULT_TIMEOUT_MS : document["timeoutMs"];
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(
      "field_invalid",
      `timeoutMs must be a whole number of milliseconds between ` +
        `${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      "timeoutMs",
    );
  }

  const headers = parseHeaders(document["headers"], auth);
  const enabled = document["enabled"] === undefined ? true : document["enabled"];
  if (typeof enabled !== "boolean") {
    fail("field_invalid", "enabled must be a boolean", "enabled");
  }
  const pinModel = document["pinModel"] === undefined ? false : document["pinModel"];
  if (typeof pinModel !== "boolean") {
    fail("field_invalid", "pinModel must be a boolean", "pinModel");
  }

  return {
    schemaVersion: SUPPORTED_PROFILE_SCHEMA_VERSION,
    id,
    displayName,
    kind,
    model,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    auth,
    timeoutMs,
    ...(headers === undefined ? {} : { headers }),
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(pinModel === false ? {} : { pinModel }),
    enabled,
  };
}

/** Validate a set, refusing duplicate ids. */
export function parseProviderProfiles(documents: readonly unknown[]): readonly ProviderProfile[] {
  const seen = new Set<string>();
  const out: ProviderProfile[] = [];
  for (const document of documents) {
    const profile = parseProviderProfile(document);
    if (seen.has(profile.id)) {
      fail("duplicate_id", `Duplicate provider profile id: ${profile.id}`, "id");
    }
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}
