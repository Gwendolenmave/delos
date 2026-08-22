/**
 * Filesystem runtime-configuration adapter.
 *
 * Reads and validates the small JSON file that tells the v0.1 reference
 * composition which endpoint, model, prompt directory and context budget to
 * use. It reads nothing else: it does not load prompts, does not touch the
 * environment, and does not construct anything.
 *
 * This is a **local runtime configuration**, not the portable Delos Profile
 * described in the architecture principles. It is deliberately narrow, and it
 * is not a migration target for that future format.
 *
 * It never holds a credential. `apiKeyEnv` names an environment variable;
 * resolving it is the composition root's job, so a secret never passes
 * through a file this adapter can read or an error it can print.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** The only provider kind v0.1 implements. */
export const SUPPORTED_PROVIDER_KIND = "openai-compatible" as const;

/** The only schema version v0.1 understands. */
const SUPPORTED_SCHEMA_VERSION = 1 as const;

/** Adapter default when `timeoutMs` is omitted. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ProviderRuntimeConfig {
  readonly kind: typeof SUPPORTED_PROVIDER_KIND;
  /**
   * API root, normally ending in `/v1` - NOT the full chat-completions
   * endpoint. The adapter appends the path it needs.
   */
  readonly baseUrl: string;
  readonly model: string;
  /** NAME of an environment variable holding the credential. Never a credential. */
  readonly apiKeyEnv?: string;
  readonly timeoutMs: number;
}

export interface RecentWindowRuntimeConfig {
  readonly maxEstimatedTokens: number;
  readonly reserveTokens: number;
}

export interface RuntimeConfig {
  readonly schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  /** Absolute, already resolved against the configuration file's directory. */
  readonly promptRoot: string;
  readonly provider: ProviderRuntimeConfig;
  readonly recentWindow: RecentWindowRuntimeConfig;
}

export type RuntimeConfigErrorKind =
  | "config_file_missing"
  | "config_path_not_a_file"
  | "config_file_unreadable"
  | "config_invalid_utf8"
  | "config_invalid_json"
  | "config_invalid_schema"
  | "config_unsupported_version";

/**
 * A configuration failure that names the field at fault.
 *
 * `field` is a path within the document such as `provider.baseUrl`, so a user
 * can find the line. The message never carries a credential value, an
 * environment dump, prompt content, or conversation text.
 */
export class RuntimeConfigError extends Error {
  constructor(
    readonly kind: RuntimeConfigErrorKind,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export interface LoadRuntimeConfigOptions {
  /** Path to the JSON configuration file. */
  readonly configPath: string;
}

const BOM = "﻿";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The path the model adapter appends, spelled out here so a user who has
 * already written it into `baseUrl` is told rather than sending it twice.
 *
 * Deliberately NOT imported from the model adapter: a configuration adapter
 * that reached into a sibling adapter would make the two impossible to replace
 * separately. This is a validation rule about what a user typed, not the
 * adapter's URL construction.
 */
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/** Trailing slashes carry no meaning in an API root, so they are removed. */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return path.slice(0, end);
}

const ROOT_KEYS = ["schemaVersion", "promptRoot", "provider", "recentWindow"];
const PROVIDER_KEYS = ["kind", "baseUrl", "model", "apiKeyEnv", "timeoutMs"];
const RECENT_WINDOW_KEYS = ["maxEstimatedTokens", "reserveTokens"];

function schemaError(message: string, field?: string): RuntimeConfigError {
  return new RuntimeConfigError("config_invalid_schema", message, field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject anything not in the allowlist.
 *
 * Unknown fields are refused rather than ignored so that a typo silently
 * disabling a setting, or a credential-bearing field like `apiKey` being
 * quietly accepted and stored in a file, both fail loudly instead.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = scope ? `${scope}.${key}` : key;
      throw schemaError(
        `Unknown configuration field "${field}". ` +
          `Allowed fields here: ${allowed.join(", ")}.`,
        field,
      );
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  { nonEmpty = true }: { nonEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw schemaError(`${field} must be a string`, field);
  }
  if (nonEmpty && value.trim().length === 0) {
    throw schemaError(`${field} must not be empty`, field);
  }
  return value;
}

function requireInteger(
  value: unknown,
  field: string,
  { min, positive = false }: { min: number; positive?: boolean },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw schemaError(`${field} must be a finite number`, field);
  }
  if (!Number.isInteger(value)) {
    throw schemaError(`${field} must be an integer`, field);
  }
  if (positive && value <= 0) {
    throw schemaError(`${field} must be greater than zero`, field);
  }
  if (value < min) {
    throw schemaError(`${field} must be ${min} or greater`, field);
  }
  return value;
}

/**
 * True for hosts that cannot leave the machine.
 *
 * Plaintext HTTP is allowed only to these, so a credential is never sent
 * unencrypted across a network by a configuration a user copied from an
 * example without reading it.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host === "[::1]" || host === "::1") return true;
  // 127.0.0.0/8 - the whole block, not just 127.0.0.1.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.every((n) => n >= 0 && n <= 255) && octets[0] === 127) return true;
  }
  return false;
}

function parseBaseUrl(value: unknown): string {
  const raw = requireString(value, "provider.baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw schemaError(
      "provider.baseUrl must be a valid absolute URL",
      "provider.baseUrl",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw schemaError(
      "provider.baseUrl must not contain a username or password. " +
        "Use provider.apiKeyEnv to name an environment variable instead.",
      "provider.baseUrl",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw schemaError(
      "provider.baseUrl must not contain a query string or fragment",
      "provider.baseUrl",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw schemaError(
      "provider.baseUrl must use http or https",
      "provider.baseUrl",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw schemaError(
      "provider.baseUrl may only use plaintext http for a loopback host " +
        "(localhost, 127.0.0.0/8, ::1). Use https for a remote endpoint, " +
        "so a credential is never sent unencrypted.",
      "provider.baseUrl",
    );
  }
  // Trailing slashes are not a difference in meaning, so the check normalises
  // them away first: `/v1/chat/completions/` is the same mistake as
  // `/v1/chat/completions`.
  if (stripTrailingSlashes(url.pathname).toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    throw schemaError(
      "provider.baseUrl must be the API root, not the full chat-completions " +
        "endpoint. For most providers the root ends in /v1. The adapter " +
        "appends /chat/completions itself, so configuring the endpoint here " +
        "would request it twice.",
      "provider.baseUrl",
    );
  }
  return raw;
}

function parseProvider(value: unknown): ProviderRuntimeConfig {
  if (!isPlainObject(value)) {
    throw schemaError("provider must be an object", "provider");
  }
  rejectUnknownKeys(value, PROVIDER_KEYS, "provider");

  const kind = requireString(value["kind"], "provider.kind");
  if (kind !== SUPPORTED_PROVIDER_KIND) {
    throw schemaError(
      `provider.kind must be "${SUPPORTED_PROVIDER_KIND}" in v0.1, received "${kind}"`,
      "provider.kind",
    );
  }

  const baseUrl = parseBaseUrl(value["baseUrl"]);
  const model = requireString(value["model"], "provider.model");

  let apiKeyEnv: string | undefined;
  if (value["apiKeyEnv"] !== undefined) {
    const name = requireString(value["apiKeyEnv"], "provider.apiKeyEnv");
    if (!ENV_NAME.test(name)) {
      throw schemaError(
        "provider.apiKeyEnv must be an environment-variable name " +
          "(letters, digits and underscore, not starting with a digit). " +
          "It names a variable; it is never the credential itself.",
        "provider.apiKeyEnv",
      );
    }
    apiKeyEnv = name;
  }

  const timeoutMs =
    value["timeoutMs"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : requireInteger(value["timeoutMs"], "provider.timeoutMs", {
          min: 1,
          positive: true,
        });

  return apiKeyEnv === undefined
    ? { kind: SUPPORTED_PROVIDER_KIND, baseUrl, model, timeoutMs }
    : { kind: SUPPORTED_PROVIDER_KIND, baseUrl, model, apiKeyEnv, timeoutMs };
}

function parseRecentWindow(value: unknown): RecentWindowRuntimeConfig {
  if (!isPlainObject(value)) {
    throw schemaError("recentWindow must be an object", "recentWindow");
  }
  rejectUnknownKeys(value, RECENT_WINDOW_KEYS, "recentWindow");

  const maxEstimatedTokens = requireInteger(
    value["maxEstimatedTokens"],
    "recentWindow.maxEstimatedTokens",
    { min: 0 },
  );
  const reserveTokens =
    value["reserveTokens"] === undefined
      ? 0
      : requireInteger(value["reserveTokens"], "recentWindow.reserveTokens", {
          min: 0,
        });

  return { maxEstimatedTokens, reserveTokens };
}

/**
 * Parse an already-decoded configuration document.
 *
 * Separated from file handling so the validation rules can be tested without
 * a filesystem, and so file errors and schema errors stay distinguishable.
 *
 * `configDir` is the directory holding the configuration file; a relative
 * `promptRoot` resolves against it rather than against the process working
 * directory, so the same configuration means the same thing wherever the
 * command is run from.
 */
function parseRuntimeConfig(
  document: unknown,
  configDir: string,
): RuntimeConfig {
  if (!isPlainObject(document)) {
    throw schemaError("Configuration must be a JSON object");
  }
  rejectUnknownKeys(document, ROOT_KEYS, "");

  const version = document["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw schemaError("schemaVersion must be an integer", "schemaVersion");
  }
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    throw new RuntimeConfigError(
      "config_unsupported_version",
      `Unsupported schemaVersion ${version}. This build understands ` +
        `version ${SUPPORTED_SCHEMA_VERSION} only.`,
      "schemaVersion",
    );
  }

  const promptRootRaw = requireString(document["promptRoot"], "promptRoot");
  const promptRoot = isAbsolute(promptRootRaw)
    ? promptRootRaw
    : resolve(configDir, promptRootRaw);

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    promptRoot,
    provider: parseProvider(document["provider"]),
    recentWindow: parseRecentWindow(document["recentWindow"]),
  };
}

/**
 * Trailing positional metadata that `JSON.parse` appends to its own message,
 * and nothing else.
 *
 * The runtime writes this suffix itself after the fixed phrase `in JSON`, so
 * the captured groups are the parser's counters. The anchor at the end matters:
 * the other message form the runtime produces quotes a slice of the document
 * and ends with `is not valid JSON`, so it cannot match here.
 */
const JSON_POSITION =
  / in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/;

/**
 * Describe *where* the document stopped parsing, using digits only.
 *
 * The parser's message is never returned, quoted, or included in any form. In
 * current runtimes it can embed a slice of the document around the fault, and
 * a credential or other secret mistakenly written into the configuration would
 * sit exactly there. Only the numbers matched above are used, each re-rendered
 * from its own parsed integer rather than copied as text, so no substring of
 * the parser's message survives into the result.
 *
 * Returns an empty string whenever the position cannot be read that way. A
 * missing line number is a smaller loss than a leaked one.
 */
function jsonErrorLocation(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const match = JSON_POSITION.exec(error.message);
  if (match === null) return "";

  const line = match[2];
  const column = match[3];
  if (line !== undefined && column !== undefined) {
    return ` (line ${Number(line)}, column ${Number(column)})`;
  }
  const position = match[1];
  return position === undefined ? "" : ` (at character ${Number(position)})`;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Read and validate the configuration file at `configPath`.
 *
 * A symbolic link is followed: the path is what the user typed, and pointing
 * it at a shared or synced file is a reasonable thing to do deliberately.
 */
export async function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions,
): Promise<RuntimeConfig> {
  const { configPath } = options;

  let info;
  try {
    // stat() follows a symlinked path by design; see the note above.
    info = await stat(configPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new RuntimeConfigError(
        "config_file_missing",
        `Configuration file does not exist: ${configPath}`,
      );
    }
    throw new RuntimeConfigError(
      "config_file_unreadable",
      `Configuration file exists but could not be inspected: ${configPath}`,
    );
  }
  if (!info.isFile()) {
    throw new RuntimeConfigError(
      "config_path_not_a_file",
      `Configuration path is not a regular file: ${configPath}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(configPath);
  } catch {
    throw new RuntimeConfigError(
      "config_file_unreadable",
      `Configuration file could not be read: ${configPath}`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeConfigError(
      "config_invalid_utf8",
      `Configuration file is not valid UTF-8: ${configPath}`,
    );
  }
  // A byte-order mark is an encoding artefact; JSON.parse rejects it.
  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new RuntimeConfigError(
      "config_invalid_json",
      `Configuration file is not valid JSON${jsonErrorLocation(error)}: ${configPath}`,
    );
  }

  return parseRuntimeConfig(document, dirname(resolve(configPath)));
}

// ---------------------------------------------------------------------------
// Schema version 2: provider profiles
// ---------------------------------------------------------------------------

/**
 * A version-2 configuration replaces the single inline provider block with a
 * list of provider-profile documents (validated by the core schema, which is
 * their single source of truth) and an optional default selection.
 *
 * Profiles remain UNVALIDATED `unknown` values here on purpose: the core
 * profile parser owns every rule about their shape, and validating them twice
 * with two vocabularies is how the two drift apart. This adapter validates
 * only what it owns - the file, the root keys, promptRoot, the window, and
 * that the default refers to a listed profile id.
 */
export interface RuntimeConfigV2 {
  readonly schemaVersion: 2;
  /** Absolute, already resolved against the configuration file's directory. */
  readonly promptRoot: string;
  /** Provider-profile documents, for `parseProviderProfiles`. */
  readonly providers: readonly unknown[];
  /** The profile id used when the CLI is not told otherwise. */
  readonly defaultProvider?: string;
  readonly recentWindow: RecentWindowRuntimeConfig;
}

export type LoadedRuntimeConfig =
  | { readonly version: 1; readonly config: RuntimeConfig }
  | { readonly version: 2; readonly config: RuntimeConfigV2 };

const ROOT_KEYS_V2 = [
  "schemaVersion",
  "promptRoot",
  "providers",
  "defaultProvider",
  "recentWindow",
];

function parseRuntimeConfigV2(
  document: Record<string, unknown>,
  configDir: string,
): RuntimeConfigV2 {
  rejectUnknownKeys(document, ROOT_KEYS_V2, "");

  const promptRootRaw = requireString(document["promptRoot"], "promptRoot");
  const promptRoot = isAbsolute(promptRootRaw)
    ? promptRootRaw
    : resolve(configDir, promptRootRaw);

  const providers = document["providers"];
  if (!Array.isArray(providers) || providers.length === 0) {
    throw schemaError(
      "providers must be a non-empty array of provider profiles",
      "providers",
    );
  }

  // The id check needs only the shape, not profile validity; full validation
  // belongs to the core parser at composition time.
  const ids: string[] = [];
  for (const entry of providers) {
    if (isPlainObject(entry) && typeof entry["id"] === "string") ids.push(entry["id"]);
  }

  let defaultProvider: string | undefined;
  if (document["defaultProvider"] !== undefined) {
    defaultProvider = requireString(document["defaultProvider"], "defaultProvider");
    if (!ids.includes(defaultProvider)) {
      throw schemaError(
        `defaultProvider "${defaultProvider}" does not match the id of any ` +
          `listed provider profile`,
        "defaultProvider",
      );
    }
  }

  return {
    schemaVersion: 2,
    promptRoot,
    providers,
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    recentWindow: parseRecentWindow(document["recentWindow"]),
  };
}

/**
 * Load a configuration of either supported schema version.
 *
 * Version 1 remains fully supported: it is the one-provider environment-driven
 * path the README quickstart uses, and every existing configuration keeps
 * working unchanged. Version 2 adds provider profiles.
 */
export async function loadAnyRuntimeConfig(
  options: LoadRuntimeConfigOptions,
): Promise<LoadedRuntimeConfig> {
  const { configPath } = options;

  // The file handling is shared with v1 by reading the document once here and
  // dispatching on its declared version.
  let info;
  try {
    info = await stat(configPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new RuntimeConfigError(
        "config_file_missing",
        `Configuration file does not exist: ${configPath}`,
      );
    }
    throw new RuntimeConfigError(
      "config_file_unreadable",
      `Configuration file exists but could not be inspected: ${configPath}`,
    );
  }
  if (!info.isFile()) {
    throw new RuntimeConfigError(
      "config_path_not_a_file",
      `Configuration path is not a regular file: ${configPath}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(configPath);
  } catch {
    throw new RuntimeConfigError(
      "config_file_unreadable",
      `Configuration file could not be read: ${configPath}`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeConfigError(
      "config_invalid_utf8",
      `Configuration file is not valid UTF-8: ${configPath}`,
    );
  }
  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new RuntimeConfigError(
      "config_invalid_json",
      `Configuration file is not valid JSON${jsonErrorLocation(error)}: ${configPath}`,
    );
  }

  if (!isPlainObject(document)) {
    throw schemaError("Configuration must be a JSON object");
  }
  const configDir = dirname(resolve(configPath));
  const version = document["schemaVersion"];
  if (version === 2) {
    return { version: 2, config: parseRuntimeConfigV2(document, configDir) };
  }
  // Anything else - including a wrong version - flows through the v1 parser,
  // which owns the v1 rules and the unsupported-version message.
  return { version: 1, config: parseRuntimeConfig(document, configDir) };
}
