/**
 * `delos --doctor`: the same checks the daemon serves, composed OFFLINE
 * from the data directory. Read-only to the letter: if no transcript
 * database exists yet, doctor says so instead of creating one, because a
 * health check that mutates the machine is lying about being a check.
 *
 * Exit code: 0 for PASS, 1 for DEGRADED, 2 for BLOCKED - documented here
 * and printed in the summary line.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { runDoctor, redactDoctorReport, type DoctorReport } from "../../core/services/doctor.js";
import {
  buildDoctorChecks,
  listPackIdsIn,
  type DoctorStoreView,
} from "../../adapters/doctor/doctor-checks.js";
import type { EvidenceSource, ExternalTurnRecord, TurnState } from "../../core/ports/transcript-store.js";
import {
  createEnvironmentSecretStore,
  DEFAULT_ENVIRONMENT_MAPPING,
} from "../../adapters/secret-store/environment/environment-secret-store.js";
import { loadPersonaPack } from "../../adapters/persona/filesystem-pack-loader.js";
import { defaultDataDir } from "../../adapters/config/app-data-dir.js";
import { parseProviderProfiles, type ProviderProfile } from "../../core/domain/provider-profile.js";
import { parseTelegramConfig, TELEGRAM_DEFAULTS } from "../../core/domain/telegram-config.js";
import type { CliStreams } from "./run-cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An honest view for a machine with no database yet - reads, never creates. */
const absentStore: DoctorStoreView = {
  async integrityCheck() {
    return { ok: true, schemaVersion: 0, detail: "no database yet - nothing has run here" };
  },
  async listRecoverableTurns() {
    return [];
  },
  async listObservations() {
    return [];
  },
};

function readOnlyStoreView(path: string): DoctorStoreView {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    async integrityCheck() {
      try {
        const quick = db.prepare("PRAGMA quick_check").all() as { quick_check?: string }[];
        const ok = quick.length === 1 && quick[0]?.quick_check === "ok";
        const version = db.prepare("SELECT version FROM schema_version").get() as
          | { version: number }
          | undefined;
        return {
          ok,
          schemaVersion: version?.version ?? 0,
          detail: ok ? "quick_check ok (read-only)" : "quick_check reported problems",
        };
      } catch {
        return { ok: false, schemaVersion: 0, detail: "The integrity probe itself failed." };
      }
    },
    async listRecoverableTurns() {
      const rows = db
        .prepare(
          `SELECT * FROM external_turns
           WHERE state IN ('received','accepted','model-pending','model-completed','delivery-pending','failed-after-model')
           ORDER BY created_at`,
        )
        .all() as Record<string, unknown>[];
      return rows.map(
        (row): ExternalTurnRecord => ({
          id: String(row["id"]),
          surface: String(row["surface"]),
          externalConversationKey: String(row["external_conversation_key"]),
          externalTurnKey: String(row["external_turn_key"]),
          conversationId: String(row["conversation_id"]),
          state: row["state"] as TurnState,
          createdAtIso: String(row["created_at"]),
          updatedAtIso: String(row["updated_at"]),
          ...(row["assistant_message_id"] == null
            ? {}
            : { assistantMessageId: String(row["assistant_message_id"]) }),
        }),
      );
    },
    async listObservations(profileId: string) {
      const rows = db
        .prepare("SELECT * FROM provider_observations WHERE profile_id = ? ORDER BY at_iso")
        .all(profileId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row["id"]),
        profileId: String(row["profile_id"]),
        configuredModel: String(row["configured_model"]),
        requestedModel: String(row["requested_model"]),
        ...(row["served_model"] == null ? {} : { servedModel: String(row["served_model"]) }),
        protocol: String(row["protocol"]),
        ...(row["capability"] == null ? {} : { capability: String(row["capability"]) }),
        evidenceSource: row["evidence_source"] as EvidenceSource,
        atIso: String(row["at_iso"]),
      }));
    },
  };
}

export interface DoctorCliOptions {
  readonly dataDir?: string;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly streams: CliStreams;
  readonly nowIso: () => string;
}

export async function runDoctorCli(options: DoctorCliOptions): Promise<number> {
  const dataDir = options.dataDir ?? defaultDataDir(options.env);
  const dbPath = join(dataDir, "transcripts.db");

  let profiles: readonly ProviderProfile[] = [];
  try {
    const raw = JSON.parse(await readFile(join(dataDir, "providers.json"), "utf8")) as {
      profiles?: unknown[];
    };
    profiles = parseProviderProfiles(raw.profiles ?? []);
  } catch {
    profiles = [];
  }
  let telegramConfig = { ...TELEGRAM_DEFAULTS };
  try {
    telegramConfig = parseTelegramConfig(JSON.parse(await readFile(join(dataDir, "telegram.json"), "utf8")));
  } catch {
    /* defaults stand */
  }

  const mapping: Record<string, string> = { ...DEFAULT_ENVIRONMENT_MAPPING };
  for (const profile of profiles) {
    if (profile.auth.source === "environment" && profile.auth.secretId && profile.auth.envVar) {
      mapping[profile.auth.secretId] = profile.auth.envVar;
    }
  }
  if (telegramConfig.tokenSecretId.length > 0 && telegramConfig.tokenEnvVar.length > 0) {
    mapping[telegramConfig.tokenSecretId] = telegramConfig.tokenEnvVar;
  }
  const secretStore = createEnvironmentSecretStore({ env: options.env, mapping });

  const shippedDir = join(HERE, "..", "..", "..", "personas");
  const userDir = join(dataDir, "personas");
  const loaded: string[] = [];
  const failed: string[] = [];
  for (const [dir, ids] of [
    [shippedDir, await listPackIdsIn(shippedDir)],
    [userDir, await listPackIdsIn(userDir)],
  ] as const) {
    for (const id of ids) {
      try {
        await loadPersonaPack({ packDir: join(dir, id) });
        loaded.push(id);
      } catch {
        failed.push(id);
      }
    }
  }

  // A READ-ONLY connection: the store adapter migrates on open, and doctor
  // must never write - not even a schema bump.
  const store: DoctorStoreView = existsSync(dbPath) ? readOnlyStoreView(dbPath) : absentStore;

  const report = await runDoctor(
    buildDoctorChecks({
      appVersion: "0.1.0-dev",
      apiVersion: 1,
      dataDir,
      store,
      profiles,
      secretStore,
      telegramConfig,
      secretStoreNames: ["environment"],
      personas: { loaded, failed },
    }),
    options.nowIso(),
  );

  render(report, options);
  return report.overall === "PASS" ? 0 : report.overall === "DEGRADED" ? 1 : 2;
}

function render(report: DoctorReport, options: DoctorCliOptions): void {
  if (options.json) {
    options.streams.stdout(JSON.stringify(redactDoctorReport(report), null, 2) + "\n");
    return;
  }
  options.streams.stdout(`delos doctor - ${report.overall}\n\n`);
  for (const check of report.checks) {
    options.streams.stdout(`  ${check.status.padEnd(8)} ${check.title}\n           ${check.detail}\n`);
  }
  options.streams.stdout(
    "\nDoctor is read-only: it repairs nothing, deletes nothing, and never\n" +
      "touches credentials. Exit codes: 0 PASS, 1 DEGRADED, 2 BLOCKED.\n",
  );
}
