/**
 * The desktop SecretStore: OS-encrypted persistence in the MAIN process.
 *
 * Electron's safeStorage is injected as a narrow interface, which keeps this
 * module testable without an Electron binary and keeps the dependency
 * surface explicit. Two modes, chosen by what the OS actually provides:
 *
 * - Encryption available: secrets persist as ciphertext in a JSON file in
 *   the app's data directory. The file holds base64 ciphertext ONLY -
 *   safeStorage decrypts through the OS keychain/keyring at read time.
 * - Encryption unavailable: session-only. Secrets live in process memory,
 *   vanish at quit, and the status surface says so honestly. Plaintext is
 *   NEVER written to disk as a fallback.
 *
 * The renderer can never read a value back through any path: the IPC surface
 * exposes set/delete/status only, and this store is consulted by the daemon
 * per provider call in the main process.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretLookup, SecretStore } from "../../core/ports/secret-store.js";

/** The slice of Electron's safeStorage this store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface DesktopSecretStoreOptions {
  readonly safeStorage: SafeStorageLike;
  /** File the CIPHERTEXT lives in. Created on first write. */
  readonly filePath: string;
}

export interface DesktopSecretStatus {
  readonly mode: "encrypted-persistent" | "session-only";
  readonly configuredIds: readonly string[];
}

export interface DesktopSecretStore extends SecretStore {
  status(): DesktopSecretStatus;
}

interface CipherFile {
  readonly schemaVersion: 1;
  readonly entries: Record<string, string>;
}

export function createDesktopSecretStore(options: DesktopSecretStoreOptions): DesktopSecretStore {
  const { safeStorage, filePath } = options;
  const persistent = safeStorage.isEncryptionAvailable();

  /** ciphertext (base64) when persistent; plaintext in memory otherwise. */
  const sessionOnly = new Map<string, string>();

  function readFileEntries(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CipherFile;
      return parsed.schemaVersion === 1 && typeof parsed.entries === "object" ? { ...parsed.entries } : {};
    } catch {
      return {};
    }
  }

  function writeFileEntries(entries: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload = JSON.stringify({ schemaVersion: 1, entries } satisfies CipherFile, null, 2);
    // Write-then-rename: a crash mid-write must not destroy existing entries.
    const temp = `${filePath}.tmp`;
    writeFileSync(temp, payload, "utf8");
    renameSync(temp, filePath);
  }

  return {
    name: persistent ? "desktop-encrypted" : "desktop-session-only",
    writable: true,

    async has(secretId: string): Promise<boolean> {
      if (persistent) return secretId in readFileEntries();
      return sessionOnly.has(secretId);
    },

    async get(secretId: string): Promise<SecretLookup> {
      if (persistent) {
        const entry = readFileEntries()[secretId];
        if (entry === undefined) {
          return {
            found: false,
            reason: "not_configured",
            detail: `No desktop secret is stored under ${secretId}.`,
          };
        }
        try {
          return { found: true, value: safeStorage.decryptString(Buffer.from(entry, "base64")) };
        } catch {
          return {
            found: false,
            reason: "unavailable",
            detail:
              `The secret ${secretId} exists but the OS could not decrypt it ` +
              `right now (keychain locked, or the ciphertext belongs to ` +
              `another machine).`,
          };
        }
      }
      const value = sessionOnly.get(secretId);
      if (value === undefined) {
        return {
          found: false,
          reason: "not_configured",
          detail:
            `No secret is stored under ${secretId}. Secure storage is not ` +
            `available on this system, so secrets last one session only.`,
        };
      }
      return { found: true, value };
    },

    async set(secretId: string, value: string): Promise<void> {
      if (persistent) {
        const entries = readFileEntries();
        entries[secretId] = safeStorage.encryptString(value).toString("base64");
        writeFileEntries(entries);
        return;
      }
      sessionOnly.set(secretId, value);
    },

    async delete(secretId: string): Promise<void> {
      if (persistent) {
        const entries = readFileEntries();
        delete entries[secretId];
        writeFileEntries(entries);
        return;
      }
      sessionOnly.delete(secretId);
    },

    status(): DesktopSecretStatus {
      return {
        mode: persistent ? "encrypted-persistent" : "session-only",
        configuredIds: persistent ? Object.keys(readFileEntries()).sort() : [...sessionOnly.keys()].sort(),
      };
    },
  };
}
