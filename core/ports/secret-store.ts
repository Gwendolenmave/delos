/**
 * Where credentials come from, as a port.
 *
 * Nothing in core reads a credential from the environment, a file, or a
 * keychain. A store is injected, and everything above it works with a
 * *reference* - a `secretId` - rather than a value. That is what lets a
 * provider profile be a plain, shareable, non-secret document.
 *
 * The contract deliberately distinguishes four outcomes that a naive
 * `get(): string | null` collapses into one. "There is no such credential
 * configured" and "the credential is configured but the keychain is locked"
 * need different messages and different user actions, and a store that cannot
 * tell them apart forces every caller to guess.
 */

/**
 * Why a lookup did not produce a value.
 *
 * `unavailable` is the interesting one: the reference is valid and the store
 * knows about it, but the value cannot be read right now. A later desktop
 * keychain adapter returns this when encryption is unavailable; the
 * environment store returns it when the variable exists but is empty, because
 * an empty credential is a configuration mistake rather than an absence.
 */
export type SecretLookupFailure =
  /** No such secret is configured. The caller should ask the user to set one. */
  | "not_configured"
  /** Configured, but the value cannot be read right now. Usually recoverable. */
  | "unavailable"
  /** The store itself failed. The reference may or may not be valid. */
  | "lookup_failed";

export type SecretLookup =
  | { readonly found: true; readonly value: string }
  | {
      readonly found: false;
      readonly reason: SecretLookupFailure;
      /**
       * Safe to show a user. Names the *reference* - an environment variable
       * name, for example - and never the value, not even a prefix of it.
       */
      readonly detail: string;
    };

/**
 * A credential source.
 *
 * `set` and `delete` are optional because read-only stores are a legitimate
 * kind: the environment store cannot write to the parent process's
 * environment, and pretending otherwise would produce a method that silently
 * does nothing. Callers test for the capability rather than assuming it.
 */
export interface SecretStore {
  /** Stable label for diagnostics. Never contains a secret. */
  readonly name: string;
  /** True when the store can write. Read-only stores report false. */
  readonly writable: boolean;

  /**
   * Whether a value could be produced, without producing it.
   *
   * Exists so a settings surface can render "credential configured" without
   * ever holding the plaintext.
   */
  has(secretId: string): Promise<boolean>;

  /** Resolve a reference, or explain why not. Never throws for a missing value. */
  get(secretId: string): Promise<SecretLookup>;

  /** Present only on writable stores. */
  set?(secretId: string, value: string): Promise<void>;

  /** Present only on writable stores. Removing an absent secret is not an error. */
  delete?(secretId: string): Promise<void>;

  /**
   * The secret IDs this store knows about.
   *
   * IDs only - never values. A settings page needs to list what is configured;
   * it never needs the plaintext, and a store that returned pairs would make
   * the safe call and the dangerous call look identical.
   */
  listIds?(): Promise<readonly string[]>;
}

/** Thrown only for genuine misuse, never for an absent credential. */
export class SecretStoreError extends Error {
  constructor(
    readonly code: "not_writable" | "invalid_secret_id" | "invalid_value",
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/**
 * Secret IDs are namespaced references, not free text.
 *
 * Constrained so an ID can be embedded in a profile document, a log line or an
 * error without escaping concerns, and so it cannot be confused with a value.
 */
const SECRET_ID = /^[a-z][a-z0-9_]*(?:[:.-][a-z0-9_]+)*$/i;

export function isValidSecretId(secretId: string): boolean {
  return secretId.length > 0 && secretId.length <= 128 && SECRET_ID.test(secretId);
}

export function assertValidSecretId(secretId: string): void {
  if (!isValidSecretId(secretId)) {
    throw new SecretStoreError(
      "invalid_secret_id",
      `Not a usable secret reference: ${JSON.stringify(secretId)}. Use ` +
        `letters, digits and the separators ":", "." or "-", for example ` +
        `"provider:my-relay".`,
    );
  }
}
