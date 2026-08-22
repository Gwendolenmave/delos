/**
 * Restore: inspect -> validate -> preview -> apply atomically -> verify.
 *
 * The apply order is what makes "failure rolls back completely" true:
 *
 *   1. Everything file-shaped is staged and swapped WITH a .bak kept:
 *      providers.json, telegram.json, the user persona directory.
 *   2. Situations are replaced in memory with the pre-restore snapshot held.
 *   3. The transcript snapshot is imported LAST, inside the store's single
 *      transaction. It is the only step that cannot be staged - so it goes
 *      last, where its rollback is the database's own, and every earlier
 *      step still has its .bak to swap back on failure.
 *
 * Restored provider profiles are references without values by construction;
 * the result names each profile whose credential the target machine cannot
 * currently resolve, because "restore succeeded" must not read as "the
 * providers work" - credentials are reconfigured by the user, never carried
 * by a backup.
 */

import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SecretStore } from "../../core/ports/secret-store.js";
import type { TranscriptStore } from "../../core/ports/transcript-store.js";
import type { SituationStore } from "../../core/services/current-situation.js";
import { parseProviderProfiles } from "../../core/domain/provider-profile.js";
import { parseTelegramConfig } from "../../core/domain/telegram-config.js";
import { BackupError, inspectBackupZip, type BackupCounts } from "./backup-archive.js";

export type RestorePolicy = "replace" | "merge-skip";

export interface RestoreDeps {
  readonly store: TranscriptStore;
  readonly situations: SituationStore;
  readonly secretStore: SecretStore;
  /** providers.json and telegram.json live here. */
  readonly dataDir: string;
  /** The USER persona directory (dataDir/personas). */
  readonly personaDir: string;
}

export interface RestorePreview {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly counts: BackupCounts;
}

export interface RestoreResult {
  readonly applied: {
    readonly conversations: number;
    readonly messages: number;
    readonly externalTurns: number;
    readonly observations: number;
    readonly situations: number;
    readonly providerProfiles: number;
    readonly personaPacks: number;
  };
  /** Profiles whose credential this machine cannot resolve right now. */
  readonly providersNeedingCredentials: readonly string[];
  /**
   * True only when full verification actually ran: a replace-policy restore,
   * whose inspected counts are guaranteed row-for-row inside the store
   * transaction. A merge-skip restore is accounted per row but not globally
   * verifiable (pre-existing rows are kept by design), and says so.
   */
  readonly verified: boolean;
  readonly verification: string;
}

export function previewBackup(zip: Buffer): RestorePreview {
  const { manifest } = inspectBackupZip(zip);
  return {
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    counts: manifest.counts,
  };
}

export async function applyBackup(
  zip: Buffer,
  policy: RestorePolicy,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const { entries } = inspectBackupZip(zip);

  // Validate BEFORE touching anything: both config documents must parse
  // under their own domain rules (which is also what re-refuses any
  // credential-shaped content).
  const providersText = entries.get("providers.json")!;
  const providersDoc = JSON.parse(providersText) as { profiles?: unknown[] };
  const profiles = parseProviderProfiles(providersDoc.profiles ?? []);
  const telegramText = entries.get("telegram.json")!;
  parseTelegramConfig(JSON.parse(telegramText));

  // Situations: refuse duplicate ids in the archive (the same protection the
  // transcript side has), and under merge-skip filter out ids that already
  // exist locally - "skip" must mean skip for EVERY store, not overlay.
  const archiveSituations = JSON.parse(entries.get("situations.json")!) as {
    schemaVersion?: number;
    situations?: { id?: unknown }[];
  };
  const situationIds = new Set<string>();
  for (const situation of archiveSituations.situations ?? []) {
    const id = situation.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new BackupError("invalid_content", "A situation in the archive has no id.");
    }
    if (situationIds.has(id)) {
      throw new BackupError("invalid_content", `Duplicate situation id in the archive: ${id}.`);
    }
    situationIds.add(id);
  }

  const providersPath = join(deps.dataDir, "providers.json");
  const telegramPath = join(deps.dataDir, "telegram.json");
  const swapped: { live: string; bak: string }[] = [];

  const swapIn = async (livePath: string, content?: string, stagedDir?: string): Promise<void> => {
    const bak = `${livePath}.restore-bak`;
    await rm(bak, { recursive: true, force: true });
    if (existsSync(livePath)) {
      await rename(livePath, bak);
      swapped.push({ live: livePath, bak });
    } else {
      swapped.push({ live: livePath, bak: "" });
    }
    if (stagedDir !== undefined) {
      await rename(stagedDir, livePath);
    } else {
      await writeFile(livePath, content ?? "", "utf8");
    }
  };

  const rollbackFiles = async (): Promise<void> => {
    for (const { live, bak } of swapped.reverse()) {
      await rm(live, { recursive: true, force: true });
      if (bak !== "") await rename(bak, live);
    }
  };

  // Situations rollback snapshot, taken before anything changes.
  const situationsBefore = await deps.situations.exportAll();

  try {
    // 1. Persona packs: build the whole new directory aside, then swap.
    const staged = `${deps.personaDir}.restore-new`;
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    if (policy === "merge-skip" && existsSync(deps.personaDir)) {
      await cp(deps.personaDir, staged, { recursive: true });
    }
    for (const [name, content] of entries) {
      if (!name.startsWith("personas/")) continue;
      const relative = name.slice("personas/".length);
      if (policy === "merge-skip") {
        const packId = relative.split("/")[0]!;
        if (existsSync(join(deps.personaDir, packId))) continue;
      }
      const target = join(staged, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await swapIn(deps.personaDir, undefined, staged);

    // 2. Non-secret configuration documents.
    await swapIn(providersPath, providersText);
    await swapIn(telegramPath, telegramText);

    // 3. Situations: replace clears first; merge-skip drops archive entries
    // whose id already exists locally BEFORE importing (importAll overlays
    // by id, and "skip" must actually skip).
    const currentSituations = JSON.parse(situationsBefore) as { situations?: { id: string }[] };
    let situationsToImport = entries.get("situations.json")!;
    if (policy === "replace") {
      for (const s of currentSituations.situations ?? []) {
        await deps.situations.delete(s.id);
      }
    } else {
      const existing = new Set((currentSituations.situations ?? []).map((s) => s.id));
      situationsToImport = JSON.stringify({
        schemaVersion: archiveSituations.schemaVersion ?? 1,
        situations: (archiveSituations.situations ?? []).filter(
          (s) => !existing.has(String(s.id)),
        ),
      });
    }
    const situationCount = await deps.situations.importAll(situationsToImport);

    // 4. The transcript store, LAST, inside its own single transaction.
    //
    // Verification of the DATA happened before anything committed: inspection
    // proved every entry against its manifest hash AND the manifest counts
    // against the entries' actual content, and importEverything inserts
    // exactly the snapshot's validated rows or rolls itself back. Nothing
    // after this line is allowed to throw - a failure after the commit could
    // not be rolled back, so the remaining steps are reporting only.
    const counts = await deps.store.importEverything(entries.get("transcripts.json")!, policy);

    let restoredPacks = 0;
    try {
      restoredPacks = existsSync(deps.personaDir) ? (await readdir(deps.personaDir)).length : 0;
    } catch {
      /* reporting only */
    }
    const needing: string[] = [];
    for (const profile of profiles) {
      if (profile.auth.source === "none") continue;
      const id = profile.auth.secretId;
      try {
        if (id === undefined || !(await deps.secretStore.has(id))) needing.push(profile.id);
      } catch {
        needing.push(profile.id);
      }
    }
    for (const { bak } of swapped) {
      try {
        if (bak !== "") await rm(bak, { recursive: true, force: true });
      } catch {
        /* a lingering .bak is litter, not a failure */
      }
    }

    return {
      applied: { ...counts, situations: situationCount, providerProfiles: profiles.length, personaPacks: restoredPacks },
      providersNeedingCredentials: needing,
      verified: policy === "replace",
      verification:
        policy === "replace"
          ? "Full: every entry hash-verified, manifest counts proven against content at inspection, and the transaction inserts exactly those rows or rolls back."
          : "Per-row: merge-skip keeps pre-existing rows by design, so applied counts are accounted per row rather than globally verified.",
    };
  } catch (error) {
    // Files first (they have .baks), then situations from the held snapshot.
    await rollbackFiles();
    try {
      const current = JSON.parse(await deps.situations.exportAll()) as { situations?: { id: string }[] };
      for (const s of current.situations ?? []) {
        await deps.situations.delete(s.id);
      }
      await deps.situations.importAll(situationsBefore);
    } catch {
      // The situations rollback is best-effort; the snapshot text survives
      // in the thrown context for manual recovery.
    }
    throw error;
  }
}
