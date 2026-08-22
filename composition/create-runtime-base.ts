/**
 * The v0.1 composition root.
 *
 * This is the only production place that knows runtime configuration, prompt
 * loading, credential resolution, the concrete model adapter and turn-service
 * construction at the same time. Every other module knows one thing.
 *
 * It is one honest function for the one real vertical path - not a dependency
 * container, provider registry, plugin manager, service locator or lifecycle
 * framework. There is a single provider kind; a direct branch is the whole
 * mechanism it needs.
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAnyRuntimeConfig,
  RuntimeConfigError,
  SUPPORTED_PROVIDER_KIND,
  type RuntimeConfig,
  type RuntimeConfigV2,
} from "../adapters/config/filesystem/runtime-config.js";
import {
  parseProviderProfiles,
  type ProviderProfile,
} from "../core/domain/provider-profile.js";
import type { DelosProvider } from "../core/ports/provider.js";
import {
  createEnvironmentSecretStore,
  DEFAULT_ENVIRONMENT_MAPPING,
} from "../adapters/secret-store/environment/environment-secret-store.js";
import { createProviderRegistry } from "../adapters/providers/registry.js";
import { asModelProvider } from "../core/services/provider-bridge.js";
import { wrapWithContainment } from "../core/services/contained-provider.js";
import { createHash } from "node:crypto";
import {
  testProviderConnection,
  type ConnectionTestReport,
} from "../core/services/connection-test.js";
import {
  loadPromptBundle,
  PromptLoadError,
} from "../adapters/identity/filesystem/prompt-loader.js";
import { createOpenAICompatibleProvider } from "../adapters/models/openai-compatible/openai-compatible-provider.js";
import type { FetchLike } from "../adapters/models/openai-compatible/openai-compatible-provider.js";

/**
 * Re-exported so a surface can pass a test double through without importing a
 * concrete adapter. Composition is the only production place that should name
 * one; a surface that imported the adapter directly would quietly become a
 * second wiring site.
 */
export type { FetchLike };
import { createTurnService, type TurnService } from "../core/services/turn-service.js";
import type { ModelProvider } from "../core/ports/model-provider.js";

export type RuntimeStartupErrorKind =
  /** The configuration names an environment variable that is absent or empty. */
  | "credential_missing"
  /** The configuration asked for a provider kind this build cannot construct. */
  | "provider_unsupported";

/**
 * A startup failure originating in composition itself.
 *
 * Configuration and identity failures are NOT wrapped in this: they already
 * carry typed kinds and safe messages, and re-wrapping would bury the field
 * name or file path that makes them useful.
 */
export class RuntimeStartupError extends Error {
  constructor(
    readonly kind: RuntimeStartupErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeStartupError";
  }
}

/**
 * What a surface prints when startup failed in a way this build does not
 * recognise.
 *
 * Unhelpful on purpose. An unrecognised throw has no message contract, so its
 * text may hold anything the runtime, a dependency or an adapter put there -
 * a path, a resolved proxy, an environment value, a fragment of a file.
 */
const UNKNOWN_STARTUP_FAILURE = "Delos could not start.";

/**
 * Turn a startup failure into a line that is safe to print.
 *
 * Exactly three error types are recognised, and each one is recognised because
 * its message contract is documented at its definition: the message names
 * files, fields, section names and environment-variable NAMES, and never
 * carries a credential value, file content, conversation text or a parser's
 * view of a document. Everything else collapses to a fixed string.
 *
 * This lives in composition because composition is already the one place that
 * knows which adapters exist. A surface importing each concrete adapter's
 * error type to format it would quietly become a second wiring site, and this
 * is deliberately not an error-handling framework: no registry, no severity,
 * no chaining, no formatting rules - one list of three, and a default.
 */
export function describeStartupFailure(error: unknown): string {
  if (
    error instanceof RuntimeConfigError ||
    error instanceof PromptLoadError ||
    error instanceof RuntimeStartupError
  ) {
    return error.message;
  }
  return UNKNOWN_STARTUP_FAILURE;
}

/** The environment, injected so nothing here reads a global. */
export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

export interface CreateRuntimeOptions {
  readonly configPath: string;
  readonly env: EnvironmentLike;
  /**
   * Select a provider profile by id. Only meaningful for a schemaVersion 2
   * configuration; absent means the configured default.
   */
  readonly providerId?: string;
  /** Injected for deterministic tests; production uses the runtime's fetch. */
  readonly fetchImpl?: FetchLike;
}

/**
 * What a surface receives.
 *
 * Deliberately small: no configuration object, no provider internals, no
 * credential, no filesystem adapter. A surface can run turns and shut down.
 * The two optional members exist only under a profile-based configuration:
 * safe metadata about the active profile, and a connection test that runs the
 * real provider path.
 */
export interface DelosRuntime {
  readonly turnService: TurnService;
  /** Non-secret identity of the selected profile. Absent for a v1 config. */
  readonly activeProfile?: { readonly id: string; readonly kind: string; readonly model: string };
  /** Probe the active provider through its real path. Absent for a v1 config. */
  readonly testConnection?: () => Promise<ConnectionTestReport>;
  close(): Promise<void>;
}

/**
 * Wrap a provider in the SAME containment seam the daemon uses, so the CLI
 * path cannot expose reasoning/thinking text or store internal envelopes.
 * B7 is a whole-application property, not a daemon-only one.
 */
function containedFor(provider: ModelProvider, providerKind: string): ModelProvider {
  return wrapWithContainment(provider, {
    providerKind,
    nowIso: () => new Date().toISOString(),
    sha256: (text: string) => createHash("sha256").update(text, "utf8").digest("hex"),
  });
}

/**
 * Read exactly the named variable.
 *
 * Never enumerates the environment, and never prints a value. Naming the
 * variable is what helps; printing what was found in it would put a
 * credential on a terminal.
 */
function resolveCredential(
  config: RuntimeConfig,
  env: EnvironmentLike,
): string | undefined {
  const name = config.provider.apiKeyEnv;
  if (name === undefined) {
    // A local endpoint may legitimately need no credential at all.
    return undefined;
  }
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new RuntimeStartupError(
      "credential_missing",
      `The configuration names environment variable ${name} for the provider ` +
        `credential, but it is not set. Set it, or remove provider.apiKeyEnv ` +
        `if the endpoint needs no authentication.`,
    );
  }
  return value;
}

/**
 * Build the runtime, or fail without leaving anything half-built.
 *
 * Ordering is deliberate: everything that can fail cheaply happens before
 * anything is constructed, so there is no partially initialised runtime to
 * clean up. If that stops being true, close what was created before rethrowing.
 */
export async function createRuntime(
  options: CreateRuntimeOptions,
): Promise<DelosRuntime> {
  const loaded = await loadAnyRuntimeConfig({ configPath: options.configPath });

  if (loaded.version === 2) {
    return createRuntimeV2(loaded.config, options);
  }
  const config = loaded.config;

  if (options.providerId !== undefined) {
    throw new RuntimeStartupError(
      "provider_unsupported",
      `--provider selects among provider profiles, which need a schemaVersion 2 ` +
        `configuration. This configuration is schemaVersion 1 and defines one ` +
        `provider inline.`,
    );
  }

  // The configuration parser already rejects any other kind; this guards the
  // seam rather than reimplementing the check as a registry.
  if (config.provider.kind !== SUPPORTED_PROVIDER_KIND) {
    throw new RuntimeStartupError(
      "provider_unsupported",
      `This build can only construct the "${SUPPORTED_PROVIDER_KIND}" provider.`,
    );
  }

  const apiKey = resolveCredential(config, options.env);
  const promptBundle = await loadPromptBundle({ promptRoot: config.promptRoot });

  const provider: ModelProvider = createOpenAICompatibleProvider({
    baseUrl: config.provider.baseUrl,
    model: config.provider.model,
    timeoutMs: config.provider.timeoutMs,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const turnService = createTurnService({
    provider: containedFor(provider, config.provider.kind),
    promptBundle,
    recentWindow: {
      maxEstimatedTokens: config.recentWindow.maxEstimatedTokens,
      reserveTokens: config.recentWindow.reserveTokens,
    },
  });

  let closed = false;
  return {
    turnService,
    async close(): Promise<void> {
      // Idempotent: a surface may call this from both a normal exit path and
      // an interrupt handler, and double-closing a provider is not its problem.
      if (closed) return;
      closed = true;
      if (provider.close !== undefined) {
        await provider.close();
      }
    },
  };
}

/**
 * The provider-profile path.
 *
 * Profiles are validated by the core schema; credentials resolve through an
 * EnvironmentSecretStore built from exactly the variables the profiles name -
 * the official defaults plus each profile's own envVar. Nothing enumerates
 * the environment.
 *
 * Credential PRESENCE is checked at startup, because that failure has a
 * useful, safe message - the variable name - and the turn service's stable
 * per-turn wording deliberately does not carry such detail. The VALUE still
 * resolves per call inside the registry, so a rotated credential takes
 * effect without rebuilding anything.
 */
async function createRuntimeV2(
  config: RuntimeConfigV2,
  options: CreateRuntimeOptions,
): Promise<DelosRuntime> {
  let profiles: readonly ProviderProfile[];
  try {
    profiles = parseProviderProfiles(config.providers);
  } catch (error) {
    throw new RuntimeStartupError(
      "provider_unsupported",
      error instanceof Error ? error.message : "A provider profile is invalid.",
    );
  }

  const selectedId = options.providerId ?? config.defaultProvider ?? profiles[0]?.id;
  const profile = profiles.find((p) => p.id === selectedId);
  if (profile === undefined) {
    throw new RuntimeStartupError(
      "provider_unsupported",
      `No provider profile has the id "${selectedId}". Configured profiles: ` +
        `${profiles.map((p) => p.id).join(", ")}.`,
    );
  }

  // The store's mapping is exactly what the profiles name: official defaults
  // for the conventional references, plus each environment-sourced profile's
  // own variable under its derived secretId.
  const mapping: Record<string, string> = { ...DEFAULT_ENVIRONMENT_MAPPING };
  for (const p of profiles) {
    if (p.auth.source === "environment" && p.auth.secretId !== undefined && p.auth.envVar !== undefined) {
      mapping[p.auth.secretId] = p.auth.envVar;
    }
  }
  const secretStore = createEnvironmentSecretStore({ env: options.env, mapping });

  // Presence check only. The store's detail names the variable, never the
  // value, so it is safe to surface as the startup failure.
  if (profile.auth.source !== "none" && profile.auth.secretId !== undefined) {
    const lookup = await secretStore.get(profile.auth.secretId);
    if (!lookup.found) {
      throw new RuntimeStartupError(
        "credential_missing",
        `The provider "${profile.id}" needs a credential. ${lookup.detail}`,
      );
    }
  }

  // Delegated child processes get a bounded, dedicated directory - NEVER the
  // invoker's working directory, which could be a repository or anything
  // private. The adapters fail closed without this.
  const delegatedWorkDir = join(tmpdir(), "delos-delegated-workdir");
  await mkdir(delegatedWorkDir, { recursive: true });

  const registry = createProviderRegistry({
    secretStore,
    delegatedWorkDir,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  let delosProvider: DelosProvider;
  try {
    delosProvider = registry.createFromProfile(profile);
  } catch (error) {
    throw new RuntimeStartupError(
      "provider_unsupported",
      error instanceof Error ? error.message : "The provider profile is unusable.",
    );
  }

  const promptBundle = await loadPromptBundle({ promptRoot: config.promptRoot });
  const turnService = createTurnService({
    provider: containedFor(asModelProvider(delosProvider), delosProvider.kind),
    promptBundle,
    recentWindow: {
      maxEstimatedTokens: config.recentWindow.maxEstimatedTokens,
      reserveTokens: config.recentWindow.reserveTokens,
    },
  });

  let closed = false;
  return {
    turnService,
    activeProfile: { id: profile.id, kind: profile.kind, model: profile.model },
    testConnection: () => testProviderConnection(delosProvider),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
    },
  };
}
