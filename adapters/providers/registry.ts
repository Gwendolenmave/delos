/**
 * The provider registry: validated profile in, working provider out.
 *
 * The registry is the only place that knows which adapter implements which
 * kind, and the only place that touches the SecretStore on a provider's
 * behalf. Adapters receive a resolved credential and never see a store;
 * surfaces receive a `DelosProvider` and never see an adapter module.
 *
 * Credentials are resolved **per call**, not at construction: a key set after
 * a failed attempt works on the next attempt without rebuilding anything, and
 * a rotated credential takes effect immediately. The cost is one store lookup
 * per turn, which every store implementation makes trivial.
 *
 * There is deliberately no module-level "active provider". A registry is
 * constructed with its dependencies, callers hold instances, and two
 * registries in one process cannot interfere.
 */

import {
  parseProviderProfile,
  type ProviderProfile,
} from "../../core/domain/provider-profile.js";
import type { ModelRequest } from "../../core/ports/model-provider.js";
import type {
  DelosProvider,
  GenerateOptions,
  ProviderTurn,
} from "../../core/ports/provider.js";
import type { SecretStore } from "../../core/ports/secret-store.js";
import { createRedactor } from "../../core/services/redaction.js";
import {
  createAnthropicProvider,
} from "./anthropic/anthropic-adapters.js";
import {
  createOpenAICompatibleProvider,
  createOpenAIResponsesProvider,
} from "./openai/openai-adapters.js";
import { ProviderError, requestRedactor, type FetchLike } from "./shared/http-provider-core.js";
import { createClaudeCodeProvider } from "./delegated/claude-code-provider.js";
import { createCodexProvider } from "./delegated/codex-provider.js";
import type { ProcessRunner, SessionStarter } from "./delegated/process-runner.js";

export interface ProviderRegistryOptions {
  readonly secretStore: SecretStore;
  /** Injected for tests; production uses the runtime's fetch. */
  readonly fetchImpl?: FetchLike;
  /** Delegated-provider seams: injected by tests, real processes otherwise. */
  readonly processRunner?: ProcessRunner;
  readonly sessionStarter?: SessionStarter;
  /** Bounded working directory delegated child processes run in. */
  readonly delegatedWorkDir?: string;
}

export interface ProviderRegistry {
  /**
   * Validate a profile document and return a working provider.
   *
   * Throws ProviderError with code "profile-invalid" for an unusable profile.
   * Credential problems are NOT thrown here - they surface per call, as
   * failures, so a UI can show "credential missing" next to a profile without
   * the registry having refused to construct it.
   */
  create(profileDocument: unknown): DelosProvider;
  /** As `create`, for an already validated profile. */
  createFromProfile(profile: ProviderProfile): DelosProvider;
}

type AdapterFactory = (options: {
  profile: ProviderProfile;
  credential?: string;
  fetchImpl?: FetchLike;
}) => DelosProvider;

const FACTORIES: Record<string, AdapterFactory> = {
  openai: createOpenAIResponsesProvider,
  "openai-compatible": createOpenAICompatibleProvider,
  anthropic: createAnthropicProvider,
  "anthropic-compatible": createAnthropicProvider,
};

export function createProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  const { secretStore } = options;

  // Delegated kinds spawn the installed tool instead of speaking HTTP. They
  // are composed here so they can carry the registry's process seams; they
  // never receive a credential - the tool owns its own login.
  const delegatedFactories: Record<string, AdapterFactory> = {
    "delegated-claude-code": ({ profile }) =>
      createClaudeCodeProvider({
        profile,
        ...(options.processRunner === undefined ? {} : { runner: options.processRunner }),
        ...(options.delegatedWorkDir === undefined ? {} : { workDir: options.delegatedWorkDir }),
      }),
    "delegated-codex": ({ profile }) =>
      createCodexProvider({
        profile,
        ...(options.sessionStarter === undefined ? {} : { startSession: options.sessionStarter }),
        ...(options.delegatedWorkDir === undefined ? {} : { workDir: options.delegatedWorkDir }),
      }),
  };

  function createFromProfile(profile: ProviderProfile): DelosProvider {
    const factory = delegatedFactories[profile.kind] ?? FACTORIES[profile.kind];
    if (factory === undefined) {
      throw new ProviderError(
        "profile-invalid",
        profile.kind,
        `No adapter implements the provider kind "${profile.kind}".`,
        "no",
        createRedactor(),
      );
    }

    if (!profile.enabled) {
      throw new ProviderError(
        "profile-invalid",
        profile.kind,
        `The provider profile "${profile.id}" is disabled.`,
        "no",
        createRedactor(),
      );
    }

    // The adapter itself is rebuilt per call with the freshly resolved
    // credential. Building one here first validates adapter-level profile
    // rules (managed headers, required baseUrl) eagerly, so an unusable
    // profile fails at creation rather than at the first turn.
    factory({ profile });

    return {
      profileId: profile.id,
      kind: profile.kind,
      protocol: factory({ profile }).protocol,

      async generate(request: ModelRequest, genOptions?: GenerateOptions): Promise<ProviderTurn> {
        let credential: string | undefined;

        if (profile.auth.source !== "none") {
          const secretId = profile.auth.secretId;
          if (secretId === undefined) {
            // parseProviderProfile guarantees this; guard the seam anyway.
            return failure(profile, "credential-missing", "The profile names no credential reference.");
          }
          const lookup = await secretStore.get(secretId);
          if (!lookup.found) {
            const code =
              lookup.reason === "not_configured" ? "credential-missing" : "credential-unavailable";
            // The lookup detail names references and variable names only -
            // that is the store's contract - so it is safe to pass through
            // the redactor and surface.
            return failure(profile, code, lookup.detail);
          }
          credential = lookup.value;
        }

        const adapter = factory({
          profile,
          ...(credential === undefined ? {} : { credential }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
        const turn = await adapter.generate(request, genOptions);

        // No-silent-fallback (B3), enforced at the ONE place every adapter
        // passes through: a pinned profile accepts a completed turn only
        // with positive evidence of the requested model. A different served
        // model is a mismatch; NO evidence is also a mismatch - pinning
        // means silence is not acceptance.
        if (turn.ok && profile.pinModel === true) {
          const served = turn.result.servedModel;
          if (served === undefined) {
            return {
              ok: false,
              error: {
                code: "model-mismatch",
                providerKind: profile.kind,
                message:
                  `The profile "${profile.id}" pins its model, but the reply carried no served-model evidence. ` +
                  `The reply was discarded rather than silently accepted.`,
                retryable: "no",
              },
            };
          }
          if (served !== profile.model) {
            return {
              ok: false,
              error: {
                code: "model-mismatch",
                providerKind: profile.kind,
                message:
                  `The profile "${profile.id}" pins "${profile.model}", but the provider served "${served}". ` +
                  `The reply was discarded rather than silently accepted.`,
                retryable: "no",
              },
            };
          }
        }
        return turn;
      },
    };
  }

  function failure(
    profile: ProviderProfile,
    code: "credential-missing" | "credential-unavailable",
    detail: string,
  ): ProviderTurn {
    const redactor = requestRedactor(undefined, profile.auth);
    return {
      ok: false,
      error: new ProviderError(
        code,
        profile.kind,
        code === "credential-missing"
          ? `No credential is configured for the provider "${profile.id}". ${detail}`
          : `The credential for the provider "${profile.id}" cannot be read. ${detail}`,
        "no",
        redactor,
      ).toFailure(),
    };
  }

  return {
    create(profileDocument: unknown): DelosProvider {
      let profile: ProviderProfile;
      try {
        profile = parseProviderProfile(profileDocument);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The profile is invalid.";
        throw new ProviderError("profile-invalid", "unknown", message, "no", createRedactor());
      }
      return createFromProfile(profile);
    },
    createFromProfile,
  };
}
