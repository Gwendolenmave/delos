/**
 * Credentials held in process memory only.
 *
 * Two real uses: tests, and a session where the user types a key that should
 * live exactly as long as the process. Nothing is written to disk, so there is
 * no file to leak, no file to forget to delete, and no file to accidentally
 * commit. When the process exits the credentials are gone.
 *
 * Durable desktop storage is a later sub-wave and belongs behind the same
 * port. This store is not a stand-in for it and does not pretend to persist.
 */

import {
  assertValidSecretId,
  SecretStoreError,
  type SecretLookup,
  type SecretStore,
} from "../../../core/ports/secret-store.js";

export interface InMemorySecretStoreOptions {
  /** Seed values, for tests that want a store already populated. */
  readonly initial?: Readonly<Record<string, string>>;
}

export function createInMemorySecretStore(
  options: InMemorySecretStoreOptions = {},
): SecretStore {
  const values = new Map<string, string>();

  for (const [secretId, value] of Object.entries(options.initial ?? {})) {
    assertValidSecretId(secretId);
    if (value.length === 0) {
      throw new SecretStoreError(
        "invalid_value",
        `Refusing to seed an empty credential for ${secretId}.`,
      );
    }
    values.set(secretId, value);
  }

  return {
    name: "in-memory",
    writable: true,

    async has(secretId: string): Promise<boolean> {
      return values.has(secretId);
    },

    async get(secretId: string): Promise<SecretLookup> {
      const value = values.get(secretId);
      if (value === undefined) {
        return {
          found: false,
          reason: "not_configured",
          detail: `No credential is held in this session for ${secretId}.`,
        };
      }
      return { found: true, value };
    },

    /** Replaces silently: setting a credential twice is how you rotate one. */
    async set(secretId: string, value: string): Promise<void> {
      assertValidSecretId(secretId);
      if (value.length === 0) {
        throw new SecretStoreError(
          "invalid_value",
          `Refusing to store an empty credential for ${secretId}. Remove it ` +
            `instead if it is not needed.`,
        );
      }
      values.set(secretId, value);
    },

    /** Removing something absent is success: the desired end state is reached. */
    async delete(secretId: string): Promise<void> {
      values.delete(secretId);
    },

    /** IDs only. There is deliberately no method that returns the values. */
    async listIds(): Promise<readonly string[]> {
      return [...values.keys()].sort();
    },
  };
}
