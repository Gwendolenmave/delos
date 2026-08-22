/**
 * The concrete doctor checks, composed from injected dependencies so the
 * daemon (live composition) and the CLI (data-directory composition) run
 * the SAME checks and differ only in what they can hand over.
 *
 * Read-only throughout: the single write this module performs is a probe
 * file in the data directory, created and deleted to prove writability -
 * which is itself one of the required checks.
 */

import { statfs, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DoctorCheck, DoctorCheckRunner } from "../../core/services/doctor.js";
import type { SecretStore } from "../../core/ports/secret-store.js";
import type { TranscriptStore } from "../../core/ports/transcript-store.js";
import type { ProviderProfile } from "../../core/domain/provider-profile.js";
import type { DaemonTelegramConfig } from "../../core/domain/telegram-config.js";
import { BACKUP_SCHEMA_VERSION } from "../backup/backup-archive.js";
import { MIGRATIONS } from "../transcripts/sqlite-transcript-store.js";
import { detectExecutable, runToCompletion } from "../providers/delegated/process-runner.js";
import { DEFAULT_CLAUDE_COMMAND } from "../providers/delegated/claude-code-provider.js";
import { DEFAULT_CODEX_COMMAND } from "../providers/delegated/codex-provider.js";

/** The slice of the store doctor reads. Narrow so an offline CLI without a
 * database can supply an honest stub instead of creating one - doctor must
 * never create data as a side effect of checking it. */
export type DoctorStoreView = Pick<
  TranscriptStore,
  "integrityCheck" | "listRecoverableTurns" | "listObservations"
>;

export interface DoctorDeps {
  readonly appVersion: string;
  readonly apiVersion: number;
  readonly dataDir: string;
  readonly store: DoctorStoreView;
  readonly profiles: readonly ProviderProfile[];
  readonly secretStore: SecretStore;
  readonly telegramConfig: DaemonTelegramConfig;
  /** Names of the secret stores in the chain, for the secure-storage check. */
  readonly secretStoreNames: readonly string[];
  /** Pack ids that LOADED successfully, and ones that failed. */
  readonly personas: { readonly loaded: readonly string[]; readonly failed: readonly string[] };
  /** The live daemon's actual bound address, when there is one. */
  readonly boundAddress?: string;
  /**
   * Optional ONLINE telegram probe (getMe + getWebhookInfo). Only ever
   * called when the caller explicitly asked for online checks; doctor's
   * default is fully offline.
   */
  readonly telegramProbe?: () => Promise<{ webhookConflict?: string; lastError?: string }>;
  /**
   * Persona ids conversations and surface defaults actively reference.
   * Absent in the offline CLI composition, which says so.
   */
  readonly activePersonaIds?: readonly string[];
  /** Optional ONLINE provider connection probe, per profile id. */
  readonly providerProbe?: (profileId: string) => Promise<{ ok: boolean; code?: string }>;
  /** Optional ONLINE codex auth inspection through the official surface. */
  readonly codexAuthProbe?: () => Promise<{ supported: boolean; authenticated?: boolean; detail: string }>;
  /** Injected for tests. */
  readonly detect?: typeof detectExecutable;
  readonly minFreeBytes?: number;
}

const check = (id: string, title: string, status: DoctorCheck["status"], detail: string): DoctorCheck => ({
  id,
  title,
  status,
  detail,
});

export function buildDoctorChecks(deps: DoctorDeps): DoctorCheckRunner[] {
  // spawn() fails on a nonexistent cwd, which would misreport an installed
  // tool as missing whenever the data directory has not been created yet.
  const probeCwd = (): string => (existsSync(deps.dataDir) ? deps.dataDir : tmpdir());
  const detect = deps.detect ?? detectExecutable;
  const expectedSchema = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

  return [
    async () =>
      check(
        "version",
        "Application and runtime",
        "PASS",
        `Delos ${deps.appVersion}, API v${deps.apiVersion}, Node ${process.versions.node}.`,
      ),

    async () => {
      if (!existsSync(deps.dataDir)) {
        // A state, not a fault: the directory is created on first run.
        return check("data-dir", "Data directory", "PASS", "Does not exist yet; it is created on first run.");
      }
      const probe = join(deps.dataDir, ".doctor-write-probe");
      try {
        await writeFile(probe, "probe", "utf8");
        await rm(probe, { force: true });
        return check("data-dir", "Data directory", "PASS", "The data directory exists and is writable.");
      } catch {
        return check("data-dir", "Data directory", "BLOCKED", "The data directory is not writable.");
      }
    },

    async () => {
      const integrity = await deps.store.integrityCheck();
      if (!integrity.ok) {
        return check("sqlite", "Transcript database", "BLOCKED", `Integrity: ${integrity.detail}.`);
      }
      if (integrity.schemaVersion === 0) {
        // No database yet is a state, not a fault: it is created on first run.
        return check("sqlite", "Transcript database", "PASS", "No database yet; it is created on first use.");
      }
      if (integrity.schemaVersion !== expectedSchema) {
        return check(
          "sqlite",
          "Transcript database",
          "BLOCKED",
          `Schema version ${integrity.schemaVersion}; this build expects ${expectedSchema}. A migration did not complete.`,
        );
      }
      return check("sqlite", "Transcript database", "PASS", `Integrity ok, schema version ${integrity.schemaVersion}.`);
    },

    async () => {
      const encrypted = deps.secretStoreNames.some((name) => name.includes("encrypted"));
      if (encrypted) {
        return check("secure-storage", "Secure secret storage", "PASS", "OS-encrypted desktop storage is active.");
      }
      const sessionOnly = deps.secretStoreNames.some((name) => name.includes("session-only"));
      if (sessionOnly) {
        return check(
          "secure-storage",
          "Secure secret storage",
          "DEGRADED",
          "The OS offers no encryption here; desktop secrets last one session only.",
        );
      }
      return check(
        "secure-storage",
        "Secure secret storage",
        "DEGRADED",
        "Environment-variable credentials only; OS-encrypted persistence needs the desktop app.",
      );
    },

    async () => {
      if (deps.boundAddress === undefined) {
        return check(
          "binding",
          "Local binding and origin policy",
          "PASS",
          "No daemon is running in this composition; the daemon refuses any non-loopback bind at startup.",
        );
      }
      return deps.boundAddress.startsWith("127.0.0.1")
        ? check(
            "binding",
            "Local binding and origin policy",
            "PASS",
            "Bound to 127.0.0.1 with header-token authentication and origin checking.",
          )
        : check("binding", "Local binding and origin policy", "BLOCKED", "The daemon is NOT bound to loopback.");
    },

    async () => {
      if (deps.personas.loaded.length === 0) {
        return check("personas", "Persona packs", "BLOCKED", "No persona pack loads; conversations cannot start.");
      }
      if (deps.personas.failed.length > 0) {
        return check(
          "personas",
          "Persona packs",
          "DEGRADED",
          `${deps.personas.loaded.length} pack(s) load; failing: ${deps.personas.failed.join(", ")}.`,
        );
      }
      return check("personas", "Persona packs", "PASS", `${deps.personas.loaded.length} pack(s) load cleanly.`);
    },

    async () => {
      // ACTIVE personas: the ones conversations and surface defaults point
      // at must actually load - a valid pack list is no comfort if the
      // selected one is broken or missing.
      const referenced = new Set(deps.activePersonaIds ?? []);
      if (deps.telegramConfig.enabled && deps.telegramConfig.defaultPersonaId.length > 0) {
        referenced.add(deps.telegramConfig.defaultPersonaId);
      }
      if (referenced.size === 0) {
        return check(
          "active-persona",
          "Active persona",
          "PASS",
          deps.activePersonaIds === undefined
            ? "No live composition here; active selections are checked when the daemon runs."
            : "Nothing references a persona yet; conversations choose one at creation.",
        );
      }
      const loaded = new Set(deps.personas.loaded);
      const broken = [...referenced].filter((id) => !loaded.has(id)).sort();
      if (broken.length === 0) {
        return check("active-persona", "Active persona", "PASS", `Every referenced persona loads (${referenced.size}).`);
      }
      const telegramBroken =
        deps.telegramConfig.enabled && broken.includes(deps.telegramConfig.defaultPersonaId);
      return check(
        "active-persona",
        "Active persona",
        telegramBroken ? "BLOCKED" : "DEGRADED",
        `Referenced persona(s) do not load: ${broken.join(", ")}.` +
          (telegramBroken ? " Telegram's default persona is among them, so its turns cannot start." : ""),
      );
    },

    async () => {
      if (deps.profiles.length === 0) {
        return check("providers", "Provider profiles", "DEGRADED", "No provider profile is configured yet.");
      }
      const missing: string[] = [];
      for (const profile of deps.profiles) {
        if (profile.auth.source === "none") continue;
        const id = profile.auth.secretId;
        if (id === undefined || !(await deps.secretStore.has(id))) missing.push(profile.id);
      }
      if (missing.length > 0) {
        return check(
          "providers",
          "Provider profiles",
          "DEGRADED",
          `${deps.profiles.length} profile(s); credentials unresolvable for: ${missing.join(", ")}. ` +
            "Connections are probed only with online checks.",
        );
      }
      if (deps.providerProbe !== undefined) {
        const failing: string[] = [];
        for (const profile of deps.profiles.filter((p) => p.enabled)) {
          try {
            const probe = await deps.providerProbe(profile.id);
            if (!probe.ok) failing.push(`${profile.id} (${probe.code ?? "failed"})`);
          } catch {
            failing.push(`${profile.id} (probe-failed)`);
          }
        }
        return failing.length === 0
          ? check(
              "providers",
              "Provider profiles",
              "PASS",
              `${deps.profiles.length} profile(s); credentials resolve; connections probed online and answering.`,
            )
          : check(
              "providers",
              "Provider profiles",
              "DEGRADED",
              `Connections failing for: ${failing.join(", ")}.`,
            );
      }
      return check(
        "providers",
        "Provider profiles",
        "PASS",
        `${deps.profiles.length} profile(s); every required credential reference resolves. ` +
          "Connections are probed only with online checks.",
      );
    },

    async () => {
      let evidenced = 0;
      for (const profile of deps.profiles) {
        const observations = await deps.store.listObservations(profile.id);
        if (observations.some((o) => o.servedModel !== undefined)) evidenced++;
      }
      if (deps.profiles.length === 0 || evidenced > 0) {
        return check(
          "model-evidence",
          "Requested vs served model evidence",
          "PASS",
          deps.profiles.length === 0
            ? "No profiles to evidence yet."
            : `${evidenced} profile(s) have served-model evidence on record.`,
        );
      }
      return check(
        "model-evidence",
        "Requested vs served model evidence",
        "DEGRADED",
        "No served-model evidence recorded yet; run a connection test or a turn.",
      );
    },

    async () => {
      const command =
        deps.profiles.find((p) => p.kind === "delegated-codex" && p.executablePath !== undefined)
          ?.executablePath ?? DEFAULT_CODEX_COMMAND;
      const detection = await detect(runToCompletion, command, probeCwd());
      const configured = deps.profiles.some((p) => p.kind === "delegated-codex");
      if (detection.installed && detection.version !== undefined) {
        if (deps.codexAuthProbe !== undefined) {
          const auth = await deps.codexAuthProbe();
          if (auth.supported && auth.authenticated === true) {
            return check("codex", "Codex CLI", "PASS", `Detected ${detection.version}; ${auth.detail}`);
          }
          if (auth.supported) {
            return check("codex", "Codex CLI", "DEGRADED", `Detected ${detection.version}; ${auth.detail}`);
          }
          return check("codex", "Codex CLI", "PASS", `Detected ${detection.version}; ${auth.detail}`);
        }
        return check(
          "codex",
          "Codex CLI",
          "PASS",
          `Detected ${detection.version}; auth state is probed through the official surface only with online checks, and inspected per turn otherwise.`,
        );
      }
      if (configured) {
        return check("codex", "Codex CLI", "BLOCKED", "A delegated-codex profile exists but the executable does not run here.");
      }
      return check("codex", "Codex CLI", "PASS", "Not usable on this machine; no delegated-codex profile depends on it.");
    },

    async () => {
      const command =
        deps.profiles.find((p) => p.kind === "delegated-claude-code" && p.executablePath !== undefined)
          ?.executablePath ?? DEFAULT_CLAUDE_COMMAND;
      const detection = await detect(runToCompletion, command, probeCwd());
      const configured = deps.profiles.some((p) => p.kind === "delegated-claude-code");
      if (detection.installed && detection.version !== undefined) {
        // Stated limitation, not an omission: the Claude CLI's official
        // non-interactive surface exposes no read-only auth query, so auth
        // state can only surface per turn (as a typed authentication
        // failure pointing at the official login).
        return check(
          "claude",
          "Claude Code CLI",
          "PASS",
          `Detected ${detection.version}; the official surface offers no read-only auth query - auth surfaces per turn as a typed failure when absent.`,
        );
      }
      if (configured) {
        return check("claude", "Claude Code CLI", "BLOCKED", "A delegated-claude-code profile exists but the executable does not run here.");
      }
      return check("claude", "Claude Code CLI", "PASS", "Not installed; no delegated-claude-code profile depends on it.");
    },

    async () => {
      const config = deps.telegramConfig;
      if (!config.enabled) {
        return check("telegram", "Telegram", "PASS", "Disabled - the default.");
      }
      if (!(await deps.secretStore.has(config.tokenSecretId))) {
        return check(
          "telegram",
          "Telegram",
          "BLOCKED",
          `Enabled, but the bot token reference (${config.tokenSecretId} -> ${config.tokenEnvVar}) does not resolve.`,
        );
      }
      if (config.allowedUserIds.length === 0) {
        return check("telegram", "Telegram", "DEGRADED", "Enabled with an empty allowlist: every sender is denied.");
      }
      if (deps.telegramProbe !== undefined) {
        const probe = await deps.telegramProbe();
        if (probe.webhookConflict !== undefined) {
          return check(
            "telegram",
            "Telegram",
            "BLOCKED",
            "A webhook is registered for this bot, so long polling cannot start. Delos never removes a webhook itself; delete it deliberately if polling is wanted.",
          );
        }
        if (probe.lastError !== undefined) {
          return check("telegram", "Telegram", "DEGRADED", "The online probe could not reach the Bot API.");
        }
        return check("telegram", "Telegram", "PASS", "Enabled; token resolves; no webhook conflict (probed online).");
      }
      return check("telegram", "Telegram", "PASS", "Enabled; token resolves. Webhook state is only probed with online checks.");
    },

    async () => {
      const pending = await deps.store.listRecoverableTurns();
      return pending.length === 0
        ? check("pending-turns", "Pending turns and deliveries", "PASS", "Nothing awaits recovery.")
        : check(
            "pending-turns",
            "Pending turns and deliveries",
            "DEGRADED",
            `${pending.length} turn(s) await recovery; the owning surface retries delivery on its next start.`,
          );
    },

    async () =>
      check(
        "backup-schema",
        "Backup schema support",
        "PASS",
        `This build reads and writes backup schemaVersion ${BACKUP_SCHEMA_VERSION}.`,
      ),

    async () => {
      try {
        const stats = await statfs(deps.dataDir);
        const free = stats.bavail * stats.bsize;
        const floor = deps.minFreeBytes ?? 500 * 1024 * 1024;
        if (free < floor / 10) {
          return check("disk", "Disk space", "BLOCKED", "The data directory's filesystem is nearly full.");
        }
        if (free < floor) {
          return check("disk", "Disk space", "DEGRADED", "Free space under the comfortable threshold.");
        }
        return check("disk", "Disk space", "PASS", `${Math.round(free / (1024 * 1024))} MB free.`);
      } catch {
        return check("disk", "Disk space", "DEGRADED", "Free space could not be determined.");
      }
    },
  ];
}

/** List user + shipped pack ids for the persona check, tolerating absence. */
export async function listPackIdsIn(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
