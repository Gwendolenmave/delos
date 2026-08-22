/**
 * The full local backup: one versioned, DETERMINISTIC ZIP.
 *
 * Contents (and nothing else): the transcript snapshot (conversations,
 * messages, external turns, provider observations), Current Situation,
 * non-secret provider profiles, non-secret Telegram settings, user persona
 * packs, and a manifest carrying schema versions, counts and a per-entry
 * SHA-256 integrity table.
 *
 * Exclusions are structural, not filtered: secrets never reach any of the
 * serialized stores in the first place (profiles and telegram settings hold
 * REFERENCES; the secret stores are not consulted here at all), no log,
 * temp file, discarded output or environment value has a serialization
 * path into these inputs, and the entry grammar cannot express a foreign
 * path.
 *
 * Determinism: entries sorted, manifest key order fixed, no generation
 * timestamp anywhere - the same state produces the same bytes, which is
 * what makes two backups comparable by hash.
 */

import { createHash } from "node:crypto";

import { readTextZip, writePackZip } from "../persona/pack-archive.js";
import { PersonaPackError, validatePackPath } from "../../core/domain/persona-pack.js";

export const BACKUP_SCHEMA_VERSION = 1;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;

export type BackupErrorCode =
  | "invalid_archive"
  | "unsupported_schema"
  | "integrity_mismatch"
  | "missing_entry"
  | "foreign_entry"
  | "invalid_content";

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

function refuse(message: string): never {
  throw new BackupError("invalid_archive", message);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The fixed top-level entries. Everything else must be a persona-pack file. */
const FIXED_ENTRIES = [
  "backup.json",
  "transcripts.json",
  "situations.json",
  "providers.json",
  "telegram.json",
] as const;

/**
 * personas/<pack-id>/<relative path>, where the relative path obeys THE
 * SAME grammar the persona pack loader enforces - the backup of a pack the
 * product accepted must never be refused by a second, subtly different
 * rule. Traversal stays inexpressible: the pack grammar refuses "." and
 * ".." segments, absolute paths, backslashes and drive letters.
 */
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateBackupEntryPath(name: string): void {
  if ((FIXED_ENTRIES as readonly string[]).includes(name)) return;
  const match = /^personas\/([^/]+)\/(.+)$/.exec(name);
  if (match !== null && PACK_ID.test(match[1]!)) {
    const relative = match[2]!;
    if (relative === "persona.json") return;
    try {
      validatePackPath(relative, `backup entry ${name}`);
      return;
    } catch (error) {
      if (!(error instanceof PersonaPackError)) throw error;
      // fall through to the foreign-entry refusal below
    }
  }
  throw new BackupError("foreign_entry", `The archive contains an entry outside the backup format: ${name}`);
}

export interface BackupPieces {
  /** store.exportEverything() */
  readonly transcripts: string;
  /** situations exportAll() */
  readonly situations: string;
  /** the non-secret providers.json document */
  readonly providers: string;
  /** the non-secret telegram.json document */
  readonly telegram: string;
  /** user persona pack files keyed by `personas/<id>/<path>` */
  readonly personaFiles: ReadonlyMap<string, string>;
  readonly appVersion: string;
  readonly transcriptSchemaVersion: number;
}

export interface BackupCounts {
  readonly conversations: number;
  readonly messages: number;
  readonly externalTurns: number;
  readonly observations: number;
  readonly situations: number;
  readonly providerProfiles: number;
  readonly personaPacks: number;
}

interface BackupManifest {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly transcriptSchemaVersion: number;
  readonly counts: BackupCounts;
  readonly integrity: Readonly<Record<string, string>>;
  readonly excluded: readonly string[];
}

function countsFrom(pieces: Omit<BackupPieces, "appVersion" | "transcriptSchemaVersion">): BackupCounts {
  const transcripts = JSON.parse(pieces.transcripts) as {
    conversations?: unknown[];
    messages?: unknown[];
    externalTurns?: unknown[];
    observations?: unknown[];
  };
  const situations = JSON.parse(pieces.situations) as { situations?: unknown[] };
  const providers = JSON.parse(pieces.providers) as { profiles?: unknown[] };
  const packIds = new Set<string>();
  for (const name of pieces.personaFiles.keys()) {
    const id = name.split("/")[1];
    if (id !== undefined) packIds.add(id);
  }
  return {
    conversations: transcripts.conversations?.length ?? 0,
    messages: transcripts.messages?.length ?? 0,
    externalTurns: transcripts.externalTurns?.length ?? 0,
    observations: transcripts.observations?.length ?? 0,
    situations: situations.situations?.length ?? 0,
    providerProfiles: providers.profiles?.length ?? 0,
    personaPacks: packIds.size,
  };
}

export function createBackupZip(pieces: BackupPieces): Buffer {
  const entries = new Map<string, string>();
  entries.set("transcripts.json", pieces.transcripts);
  entries.set("situations.json", pieces.situations);
  entries.set("providers.json", pieces.providers);
  entries.set("telegram.json", pieces.telegram);
  for (const [name, content] of pieces.personaFiles) {
    validateBackupEntryPath(name);
    entries.set(name, content);
  }

  const integrity: Record<string, string> = {};
  for (const name of [...entries.keys()].sort()) {
    integrity[name] = sha256(entries.get(name)!);
  }
  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: pieces.appVersion,
    transcriptSchemaVersion: pieces.transcriptSchemaVersion,
    counts: countsFrom(pieces),
    integrity,
    excluded: [
      "API keys and every other secret VALUE (profiles and telegram settings hold references only)",
      "Codex/Claude login state (owned by those tools; never read)",
      "cookies, keychain data, environment variables, logs, temporary files",
      "Private Delos data (this application has no path to it)",
    ],
  };
  entries.set("backup.json", JSON.stringify(manifest, null, 2));
  return writePackZip(entries);
}

export interface BackupInspection {
  readonly manifest: BackupManifest;
  readonly entries: ReadonlyMap<string, string>;
}

export function inspectBackupZip(zip: Buffer): BackupInspection {
  const entries = readTextZip(zip, {
    maxArchiveBytes: MAX_BACKUP_BYTES,
    maxFileBytes: MAX_BACKUP_FILE_BYTES,
    validateEntryPath: validateBackupEntryPath,
    refuseWith: refuse,
  });

  const manifestText = entries.get("backup.json");
  if (manifestText === undefined) {
    throw new BackupError("missing_entry", "The archive has no backup.json manifest.");
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestText) as BackupManifest;
  } catch {
    throw new BackupError("invalid_content", "backup.json is not valid JSON.");
  }
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupError(
      "unsupported_schema",
      `This build understands backup schemaVersion ${BACKUP_SCHEMA_VERSION}; the archive declares ${String(manifest.schemaVersion)}.`,
    );
  }

  // Integrity is bidirectional: every listed file must exist and match its
  // hash, and every present file must be listed. A backup with an extra,
  // unaccounted entry is as refused as one with a missing entry.
  for (const [name, expected] of Object.entries(manifest.integrity ?? {})) {
    const content = entries.get(name);
    if (content === undefined) {
      throw new BackupError("missing_entry", `The manifest lists ${name} but the archive does not contain it.`);
    }
    if (sha256(content) !== expected) {
      throw new BackupError("integrity_mismatch", `${name} does not match its manifest hash.`);
    }
  }
  for (const name of entries.keys()) {
    if (name === "backup.json") continue;
    if (manifest.integrity?.[name] === undefined) {
      throw new BackupError("foreign_entry", `The archive contains ${name}, which the manifest does not account for.`);
    }
  }
  for (const required of FIXED_ENTRIES) {
    if (required !== "backup.json" && !entries.has(required)) {
      throw new BackupError("missing_entry", `The archive is missing ${required}.`);
    }
  }

  // The manifest cannot vouch for itself (it cannot contain its own hash),
  // so its COUNTS are re-derived from the verified entries and must match.
  // A tampered backup.json is refused here, at inspection - never later,
  // where a mismatch could surface after state has begun to change.
  let derived: BackupCounts;
  try {
    derived = countsFrom({
      transcripts: entries.get("transcripts.json")!,
      situations: entries.get("situations.json")!,
      providers: entries.get("providers.json")!,
      telegram: entries.get("telegram.json")!,
      personaFiles: new Map([...entries].filter(([name]) => name.startsWith("personas/"))),
    });
  } catch {
    throw new BackupError("invalid_content", "An archive entry is not the JSON document it claims to be.");
  }
  for (const [key, value] of Object.entries(derived)) {
    if (manifest.counts?.[key as keyof BackupCounts] !== value) {
      throw new BackupError(
        "integrity_mismatch",
        `The manifest's ${key} count does not match the archive's actual content.`,
      );
    }
  }

  return { manifest, entries };
}
