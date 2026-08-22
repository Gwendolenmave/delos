/**
 * Credentials from named environment variables.
 *
 * The headless path: a user exports `OPENAI_API_KEY`, and Delos reads exactly
 * that one variable. The mapping from secret reference to variable name is
 * explicit and supplied by the caller, so nothing here guesses at names and
 * nothing walks the environment looking for something that might be a key.
 *
 * **The environment is never enumerated.** Not for listing, not for
 * diagnostics, not for "did you mean". `listIds` reports the *configured
 * mapping*, which the caller already knows, and never reports which variables
 * happen to be set. A store that could dump the environment would eventually
 * dump it into an error message.
 */

import {
  assertValidSecretId,
  SecretStoreError,
  type SecretLookup,
  type SecretStore,
} from "../../../core/ports/secret-store.js";

/** The environment, injected. Nothing here reaches for a global. */
export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

export interface EnvironmentSecretStoreOptions {
  readonly env: EnvironmentLike;
  /**
   * secretId -> environment variable name.
   *
   * Explicit on purpose: a profile references `provider:my-relay`, and the
   * deployment decides that means `MY_RELAY_TOKEN`. Neither half guesses.
   */
  readonly mapping: Readonly<Record<string, string>>;
}

/**
 * Conventional references for the two official providers.
 *
 * Offered as a default mapping so the common case needs no configuration, and
 * exported so documentation and tests name the same constants the code uses.
 */
export const OPENAI_SECRET_ID = "provider:openai";
export const ANTHROPIC_SECRET_ID = "provider:anthropic";

export const DEFAULT_ENVIRONMENT_MAPPING: Readonly<Record<string, string>> =
  Object.freeze({
    [OPENAI_SECRET_ID]: "OPENAI_API_KEY",
    [ANTHROPIC_SECRET_ID]: "ANTHROPIC_API_KEY",
  });

/** Environment variable names, as the shell defines them. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createEnvironmentSecretStore(
  options: EnvironmentSecretStoreOptions,
): SecretStore {
  const { env } = options;

  const mapping = new Map<string, string>();
  for (const [secretId, variable] of Object.entries(options.mapping)) {
    assertValidSecretId(secretId);
    if (!ENV_NAME.test(variable)) {
      throw new SecretStoreError(
        "invalid_secret_id",
        `Not a usable environment variable name for ${secretId}: ` +
          `${JSON.stringify(variable)}.`,
      );
    }
    mapping.set(secretId, variable);
  }

  /**
   * Read exactly one named variable.
   *
   * An empty or whitespace-only value is reported as `unavailable` rather than
   * `not_configured`: the user did set the variable, and telling them it is
   * missing would send them to fix the wrong thing. The value itself is never
   * trimmed - a credential is opaque, and trimming could silently corrupt a
   * token whose format we do not get to have opinions about.
   */
  function read(secretId: string): SecretLookup {
    const variable = mapping.get(secretId);
    if (variable === undefined) {
      return {
        found: false,
        reason: "not_configured",
        detail:
          `No environment variable is mapped to the secret ${secretId}. ` +
          `Add a mapping, or choose a different credential source.`,
      };
    }
    const value = env[variable];
    if (value === undefined) {
      return {
        found: false,
        reason: "not_configured",
        detail: `The environment variable ${variable} is not set.`,
      };
    }
    if (value.trim().length === 0) {
      return {
        found: false,
        reason: "unavailable",
        detail: `The environment variable ${variable} is set but empty.`,
      };
    }
    return { found: true, value };
  }

  return {
    name: "environment",
    // The parent process's environment cannot be written from here, and a
    // set() that silently did nothing would be worse than an absent one.
    writable: false,

    async has(secretId: string): Promise<boolean> {
      return read(secretId).found;
    },

    async get(secretId: string): Promise<SecretLookup> {
      return read(secretId);
    },

    /** The configured mapping's keys. Never which variables are actually set. */
    async listIds(): Promise<readonly string[]> {
      return [...mapping.keys()].sort();
    },
  };
}
