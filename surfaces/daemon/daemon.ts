/**
 * The local Delos daemon: one process that owns runtime composition and
 * serves the versioned local API plus the web application.
 *
 * Everything a surface can do goes through /api/v1 behind the security gate
 * in http-core. The daemon owns: provider profiles (non-secret documents in
 * the data directory, seeded from the configuration file), persona packs
 * (shipped packs read-only beside the install; user packs in the data
 * directory), Current Situation state (file-backed), the SQLite transcript
 * store, and the turn coordinator. Web, CLI and later surfaces are callers,
 * not owners.
 *
 * Honesty notes, stated rather than implied: cancellation of an in-flight
 * provider call is NOT yet wired through the coordinator and its endpoint
 * says so; Telegram and delegated-provider endpoints report their Phase 5
 * status truthfully rather than pretending.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { BackupError, createBackupZip } from "../../adapters/backup/backup-archive.js";
import { applyBackup, previewBackup } from "../../adapters/backup/restore.js";
import { buildDoctorChecks } from "../../adapters/doctor/doctor-checks.js";
import {
  createMnemosyneMemoryContextProvider,
  type MnemosynePackageLoader,
} from "../../adapters/memory/mnemosyne-package.js";
import { MemoryTurnReceiptStore } from "../../adapters/memory/memory-turn-receipts.js";
import {
  createMnemosyneDecisionRuntime,
  type MemoryDecisionMode,
  type MnemosyneDecisionRuntime,
} from "../../adapters/memory/mnemosyne-decision-runtime.js";
import { redactDoctorReport, runDoctor } from "../../core/services/doctor.js";

import {
  parseProviderProfile,
  parseProviderProfiles,
  type ProviderProfile,
} from "../../core/domain/provider-profile.js";
import { PersonaPackError } from "../../core/domain/persona-pack.js";
import type { DelosProvider } from "../../core/ports/provider.js";
import type { TranscriptStore } from "../../core/ports/transcript-store.js";
import type { MemoryContextProvider } from "../../core/ports/memory-context.js";
import { asModelProvider } from "../../core/services/provider-bridge.js";
import { wrapWithContainment } from "../../core/services/contained-provider.js";
import type { ModelProvider, ModelRequest } from "../../core/ports/model-provider.js";
import { assembleContext } from "../../core/services/context-assembly.js";
import { containModelOutput } from "../../core/services/output-containment.js";
import { testProviderConnection } from "../../core/services/connection-test.js";
import { createTrustedClock } from "../../core/services/trusted-time.js";
import {
  createTurnCoordinator,
  type DeliveredTurnNotice,
  type TurnCoordinator,
} from "../../core/services/turn-coordinator.js";
import {
  createInMemoryHistoryReader,
  type HistoryQuery,
  type HistoryRecord,
} from "../../core/services/history-read.js";
import {
  createInMemorySituationStore,
  type SituationStore,
} from "../../core/services/current-situation.js";
import { resolveVariants, type LoadedPersonaPack } from "../../core/services/variant-resolver.js";
import { deriveMemoryScene } from "../../core/services/memory-scene.js";
import {
  contextualizeCurrentMessage,
  HOST_CONTEXT_SYSTEM_RULE,
} from "../../core/services/turn-context.js";
import { estimateTokens } from "../../core/services/token-estimate.js";
import { sanitizeReplyText } from "../../core/services/reply-sanitizer.js";
import { createProviderRegistry } from "../../adapters/providers/registry.js";
import {
  createEnvironmentSecretStore,
  DEFAULT_ENVIRONMENT_MAPPING,
} from "../../adapters/secret-store/environment/environment-secret-store.js";
import type { SecretStore } from "../../core/ports/secret-store.js";
import {
  parseTelegramConfig,
  TELEGRAM_DEFAULTS,
  TelegramConfigError,
  type DaemonTelegramConfig,
} from "../../core/domain/telegram-config.js";
import { createTelegramSurface, type TelegramSurface } from "../telegram/telegram-surface.js";
import { renderUntrustedBlock, UNTRUSTED_PREAMBLE } from "../../core/services/delimiter-guard.js";
import {
  describeEgress,
  EGRESS_DEFAULTS,
  evaluateEgress,
  parseEgressConfig,
  type EgressPolicyConfig,
} from "../../core/services/egress-policy.js";
import {
  decideProactive,
  guardProactiveEcho,
  parseProactiveConfig,
  PROACTIVE_DEFAULTS,
  PROACTIVE_STATE_EMPTY,
  recordProactiveSent,
  recordUserMessage,
  resumeProactive,
  type ProactiveConfig,
  type ProactiveState,
} from "../../core/services/proactive.js";
import { MAX_ATTACHMENT_BYTES, type SttAdapter } from "../../core/ports/attachment.js";
import { cleanupAbandoned } from "../../adapters/attachments/attachment-intake.js";
import { createExternalCommandStt } from "../../adapters/attachments/external-command-stt.js";
import { detectExecutable, runToCompletion } from "../../adapters/providers/delegated/process-runner.js";
import { DEFAULT_CLAUDE_COMMAND } from "../../adapters/providers/delegated/claude-code-provider.js";
import { DEFAULT_CODEX_COMMAND, inspectCodexAuth } from "../../adapters/providers/delegated/codex-provider.js";
import { loadPersonaPack } from "../../adapters/persona/filesystem-pack-loader.js";
import {
  createPackFromPastedPrompt,
  createPackFromWizard,
  duplicatePack,
  exportPackZip,
  importPackZip,
} from "../../adapters/persona/pack-io.js";
import { readPackZip } from "../../adapters/persona/pack-archive.js";
import { createSqliteTranscriptStore } from "../../adapters/transcripts/sqlite-transcript-store.js";
import type { FetchLike } from "../../adapters/providers/shared/http-provider-core.js";
import {
  API_PREFIX,
  gate,
  HttpError,
  openSse,
  Router,
  sendError,
  sendJson,
  type SseConnection,
} from "./http-core.js";

export const DAEMON_VERSION = "0.1.0-dev";
export const API_VERSION = 1;

export interface DaemonOptions {
  /** Data directory; created if absent. Holds db, profiles, personas, state. */
  readonly dataDir: string;
  /** Directory of shipped read-only packs (the repository's personas/). */
  readonly shippedPersonaDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Seed profiles (validated documents) used when the data dir has none. */
  readonly seedProfiles?: readonly unknown[];
  readonly fetchImpl?: FetchLike;
  readonly host?: string;
  readonly port?: number;
  readonly timeZone?: string;
  /** Bot API origin override so tests speak to a loopback fake. */
  readonly telegramApiOrigin?: string;
  /** Test seam for the optional public Mnemosyne package. */
  readonly memoryPackageLoader?: MnemosynePackageLoader;
  /**
   * Additional secret stores consulted IN ORDER before the environment
   * store. The desktop shell injects its OS-encrypted store here; the
   * daemon itself never learns which store answered.
   */
  readonly secretStores?: readonly SecretStore[];
}

export interface RunningDaemon {
  readonly port: number;
  readonly origin: string;
  readonly sessionToken: string;
  close(): Promise<void>;
}

const sha256hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface DaemonMemoryOffConfig {
  readonly backend: "off";
  readonly decisions: "off";
}
interface DaemonMnemosyneConfig {
  readonly backend: "mnemosyne";
  readonly dbPath: string;
  readonly decisions: "off" | MemoryDecisionMode;
  readonly policyId?: string;
  readonly decisionProviderId?: string;
  readonly decisionPersonaId?: string;
  readonly authorityRef?: `sha256:${string}`;
  readonly effectiveFrom?: string;
}
type DaemonMemoryConfig = DaemonMemoryOffConfig | DaemonMnemosyneConfig;

function resolveDataPath(dataDir: string, raw: string): string {
  return isAbsolute(raw) ? raw : join(dataDir, raw);
}

function parseDaemonMemoryConfig(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): DaemonMemoryConfig {
  const backend = (env["DELOS_MEMORY_BACKEND"] ?? "off").trim().toLowerCase();
  if (backend === "off" || backend.length === 0) return { backend: "off", decisions: "off" };
  if (backend !== "mnemosyne") {
    throw new Error("Unsupported DELOS_MEMORY_BACKEND. Expected off or mnemosyne.");
  }
  const dbRaw = env["DELOS_MEMORY_DB_PATH"]?.trim();
  if (!dbRaw) throw new Error("Memory backend mnemosyne requires DELOS_MEMORY_DB_PATH.");
  const decisionsRaw = (env["DELOS_MEMORY_DECISIONS"] ?? "off").trim().toLowerCase();
  if (!(["off", "enqueue-only", "full"] as const).includes(decisionsRaw as "off" | MemoryDecisionMode)) {
    throw new Error("Unsupported DELOS_MEMORY_DECISIONS. Expected off, enqueue-only, or full.");
  }
  const decisions = decisionsRaw as "off" | MemoryDecisionMode;
  if (decisions === "off") {
    return { backend: "mnemosyne", dbPath: resolveDataPath(dataDir, dbRaw), decisions };
  }

  const policyId = env["DELOS_MEMORY_POLICY_ID"]?.trim();
  if (!policyId) throw new Error("Memory decisions require DELOS_MEMORY_POLICY_ID.");
  if (decisions === "enqueue-only") {
    return {
      backend: "mnemosyne",
      dbPath: resolveDataPath(dataDir, dbRaw),
      decisions,
      policyId,
    };
  }

  const decisionProviderId = env["DELOS_MEMORY_DECISION_PROVIDER_ID"]?.trim();
  const decisionPersonaId = env["DELOS_MEMORY_DECISION_PERSONA_ID"]?.trim();
  const authoritySha = env["DELOS_MEMORY_POLICY_AUTHORITY_SHA256"]?.trim().toLowerCase();
  const effectiveRaw = env["DELOS_MEMORY_POLICY_EFFECTIVE_FROM"]?.trim();
  if (!decisionProviderId || !decisionPersonaId) {
    throw new Error(
      "Full memory decisions require DELOS_MEMORY_DECISION_PROVIDER_ID and DELOS_MEMORY_DECISION_PERSONA_ID.",
    );
  }
  if (authoritySha === undefined || !/^[a-f0-9]{64}$/.test(authoritySha)) {
    throw new Error("Full memory decisions require a 64-hex DELOS_MEMORY_POLICY_AUTHORITY_SHA256.");
  }
  if (effectiveRaw === undefined || !Number.isFinite(Date.parse(effectiveRaw))) {
    throw new Error("Full memory decisions require a valid DELOS_MEMORY_POLICY_EFFECTIVE_FROM timestamp.");
  }
  return {
    backend: "mnemosyne",
    dbPath: resolveDataPath(dataDir, dbRaw),
    decisions,
    policyId,
    decisionProviderId,
    decisionPersonaId,
    authorityRef: `sha256:${authoritySha}`,
    effectiveFrom: new Date(effectiveRaw).toISOString(),
  };
}

/** Telegram config parsing lives in core/domain/telegram-config.ts; the
 * daemon only translates its refusal into an HTTP 400. */
function parseTelegramConfigHttp(input: unknown): DaemonTelegramConfig {
  try {
    return parseTelegramConfig(input);
  } catch (error) {
    if (error instanceof TelegramConfigError) {
      throw new HttpError(400, "invalid", error.message);
    }
    throw error;
  }
}

interface TurnEvent {
  readonly kind: string;
  readonly conversationId: string;
  readonly detail?: unknown;
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    // The default is the contract; anything else is refused rather than
    // silently widened. LAN exposure is explicitly out of scope.
    throw new Error("The daemon binds 127.0.0.1 only in this version.");
  }

  await mkdir(options.dataDir, { recursive: true });
  await mkdir(join(options.dataDir, "personas"), { recursive: true });
  const memoryConfig = parseDaemonMemoryConfig(options.env, options.dataDir);

  // --- providers ------------------------------------------------------------
  const profilesPath = join(options.dataDir, "providers.json");
  let profiles: ProviderProfile[] = [];
  try {
    const raw = JSON.parse(await readFile(profilesPath, "utf8")) as { profiles: unknown[] };
    profiles = [...parseProviderProfiles(raw.profiles)];
  } catch {
    profiles = [...parseProviderProfiles(options.seedProfiles ?? [])];
    await saveProfiles();
  }
  async function saveProfiles(): Promise<void> {
    await writeFile(
      profilesPath,
      JSON.stringify({ schemaVersion: 1, profiles }, null, 2),
      "utf8",
    );
  }

  const mapping: Record<string, string> = { ...DEFAULT_ENVIRONMENT_MAPPING };
  // The environment store snapshots its mapping at construction, so it is
  // REBUILT whenever the mapping changes - otherwise a profile created at
  // runtime could not resolve its secret until a daemon restart. The stable
  // `secretStore` below delegates to the current instance.
  let envSecretStore = createEnvironmentSecretStore({ env: options.env, mapping });
  function refreshMapping(): void {
    for (const p of profiles) {
      if (p.auth.source === "environment" && p.auth.secretId && p.auth.envVar) {
        mapping[p.auth.secretId] = p.auth.envVar;
      }
    }
    if (telegramConfig.tokenSecretId.length > 0 && telegramConfig.tokenEnvVar.length > 0) {
      mapping[telegramConfig.tokenSecretId] = telegramConfig.tokenEnvVar;
    }
    envSecretStore = createEnvironmentSecretStore({ env: options.env, mapping });
  }
  const secretStore: SecretStore = {
    name: "daemon-chain",
    writable: false,
    has: async (id) => {
      for (const store of options.secretStores ?? []) {
        if (await store.has(id)) return true;
      }
      return envSecretStore.has(id);
    },
    get: async (id) => {
      // First found value wins. If a chained store KNOWS the secret but
      // cannot read it right now, that answer is more actionable than the
      // environment store's "not configured" - keep it.
      let unavailable: Awaited<ReturnType<SecretStore["get"]>> | undefined;
      for (const store of options.secretStores ?? []) {
        const lookup = await store.get(id);
        if (lookup.found) return lookup;
        if (lookup.reason === "unavailable" && unavailable === undefined) unavailable = lookup;
      }
      const fromEnv = await envSecretStore.get(id);
      if (!fromEnv.found && unavailable !== undefined) return unavailable;
      return fromEnv;
    },
  };
  // --- telegram configuration (non-secret; the token stays a reference) -----
  const telegramPath = join(options.dataDir, "telegram.json");
  let telegramConfig: DaemonTelegramConfig = { ...TELEGRAM_DEFAULTS };
  try {
    telegramConfig = parseTelegramConfigHttp(JSON.parse(await readFile(telegramPath, "utf8")));
  } catch {
    await saveTelegramConfig();
  }
  async function saveTelegramConfig(): Promise<void> {
    await writeFile(
      telegramPath,
      JSON.stringify({ schemaVersion: 1, ...telegramConfig }, null, 2),
      "utf8",
    );
  }
  refreshMapping();

  // --- egress policy (retrieval stays OFF by default; mechanisms only) ------
  const egressPath = join(options.dataDir, "egress.json");
  let egressConfig: EgressPolicyConfig = { ...EGRESS_DEFAULTS };
  try {
    egressConfig = parseEgressConfig(JSON.parse(await readFile(egressPath, "utf8")));
  } catch {
    await saveEgressConfig();
  }
  async function saveEgressConfig(): Promise<void> {
    await writeFile(egressPath, JSON.stringify({ schemaVersion: 1, ...egressConfig }, null, 2), "utf8");
  }

  // --- proactive runtime (OFF by default; no hidden timers - an explicit
  // tick seam drives it, so all timing is visible and editable) -------------
  const proactivePath = join(options.dataDir, "proactive.json");
  let proactiveConfig: ProactiveConfig = { ...PROACTIVE_DEFAULTS };
  let proactiveState: ProactiveState = { ...PROACTIVE_STATE_EMPTY };
  try {
    const raw = JSON.parse(await readFile(proactivePath, "utf8")) as {
      config?: unknown;
      state?: ProactiveState;
    };
    proactiveConfig = parseProactiveConfig(raw.config);
    if (raw.state !== undefined) proactiveState = { ...PROACTIVE_STATE_EMPTY, ...raw.state };
  } catch {
    await saveProactive();
  }
  async function saveProactive(): Promise<void> {
    await writeFile(
      proactivePath,
      JSON.stringify({ schemaVersion: 1, config: proactiveConfig, state: proactiveState }, null, 2),
      "utf8",
    );
  }
  /** Turns currently being processed by this daemon's message route. */
  let userTurnsInFlight = 0;

  // --- attachments / STT (13.1): local, pluggable, absent by default -------
  const attachmentsDir = join(options.dataDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  await cleanupAbandoned(attachmentsDir, 6 * 3600_000, Date.now());
  let sttAdapter: SttAdapter | undefined;
  try {
    const raw = JSON.parse(await readFile(join(options.dataDir, "stt.json"), "utf8")) as {
      command?: string;
      args?: unknown;
    };
    if (typeof raw.command === "string" && raw.command.length > 0) {
      sttAdapter = createExternalCommandStt({
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
        workDir: attachmentsDir,
      });
    }
  } catch {
    // No stt.json: voice input stays truthfully unsupported.
  }

  // Delegated child processes run in a bounded, empty directory under the
  // data dir - never the repository, never anything private.
  const delegatedWorkDir = join(options.dataDir, "delegated-workdir");
  await mkdir(delegatedWorkDir, { recursive: true });

  const registry = createProviderRegistry({
    secretStore,
    delegatedWorkDir,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  function providerFor(profileId: string): DelosProvider {
    const profile = profiles.find((p) => p.id === profileId);
    if (profile === undefined) throw new HttpError(404, "not_found", "No such provider profile.");
    return registry.createFromProfile(profile);
  }

  // --- personas -------------------------------------------------------------
  const userPersonaDir = join(options.dataDir, "personas");

  async function listPackIds(): Promise<{ shipped: string[]; user: string[] }> {
    const read = async (dir: string): Promise<string[]> => {
      try {
        return (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        return [];
      }
    };
    return { shipped: await read(options.shippedPersonaDir), user: await read(userPersonaDir) };
  }

  async function loadPack(personaId: string): Promise<{ pack: LoadedPersonaPack; shipped: boolean }> {
    const { shipped, user } = await listPackIds();
    if (user.includes(personaId)) {
      return { pack: await loadPersonaPack({ packDir: join(userPersonaDir, personaId) }), shipped: false };
    }
    if (shipped.includes(personaId)) {
      return { pack: await loadPersonaPack({ packDir: join(options.shippedPersonaDir, personaId) }), shipped: true };
    }
    throw new HttpError(404, "not_found", "No such persona.");
  }

  /** Write a pack into the user directory via its own canonical export. */
  async function writeUserPack(pack: LoadedPersonaPack): Promise<void> {
    const entries = readPackZip(exportPackZip(pack));
    const root = join(userPersonaDir, pack.manifest.id);
    await rm(root, { recursive: true, force: true });
    for (const [rel, content] of entries) {
      const full = join(root, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, "utf8");
    }
  }

  // --- situations (file-backed) ---------------------------------------------
  const situationsPath = join(options.dataDir, "situations.json");
  const situations: SituationStore = createInMemorySituationStore(() => `sit-${randomUUID()}`);
  try {
    await situations.importAll(await readFile(situationsPath, "utf8"));
  } catch {
    /* first run */
  }
  async function persistSituations(): Promise<void> {
    await writeFile(situationsPath, await situations.exportAll(), "utf8");
  }

  // --- transcript store and coordinator -------------------------------------
  const transcriptDbPath = join(options.dataDir, "transcripts.db");
  const store: TranscriptStore = createSqliteTranscriptStore({
    path: transcriptDbPath,
    newId: (prefix) => `${prefix}-${randomUUID()}`,
  });
  const clock = createTrustedClock(
    options.timeZone === undefined ? {} : { timeZone: options.timeZone },
  );
  const nowIso = (): string => new Date(clock.now().epochMs).toISOString();

  // SSE event bus, per conversation.
  const listeners = new Map<string, Set<SseConnection>>();
  function publish(event: TurnEvent): void {
    for (const connection of listeners.get(event.conversationId) ?? []) {
      connection.send(event.kind, event);
    }
  }

  /**
   * Containment BEFORE persistence (B7): the coordinator stores whatever the
   * provider returned, and everything downstream - the messages API, SSE,
   * exports, backups - reads that stored text. So reasoning wrappers and
   * fake-role continuations are stripped here, on the provider seam itself;
   * no surface can expose what was never stored. The later per-surface
   * containment calls remain as defence in depth and are no-ops on text
   * this wrapper already cleaned.
   */
  function containedModelProvider(profileId: string): ModelProvider {
    return wrapWithContainment(asModelProvider(providerFor(profileId)), {
      providerKind: profileId,
      nowIso,
      sha256: sha256hex,
    });
  }

  // --- Mnemosyne host composition -------------------------------------------
  let memoryContextProvider: MemoryContextProvider | undefined;
  let memoryReceipts: MemoryTurnReceiptStore | undefined;
  let memoryDecisions: MnemosyneDecisionRuntime | undefined;
  const memoryAuditPath = join(options.dataDir, "memory-decisions-audit.jsonl");
  const memoryAudit = (event: Readonly<Record<string, unknown>>): void => {
    appendFileSync(memoryAuditPath, `${JSON.stringify({ at: nowIso(), ...event })}\n`, "utf8");
  };

  if (memoryConfig.backend === "mnemosyne") {
    memoryContextProvider = await createMnemosyneMemoryContextProvider({
      dbPath: memoryConfig.dbPath,
      ...(options.memoryPackageLoader === undefined ? {} : { loadPackage: options.memoryPackageLoader }),
    });

    if (memoryConfig.decisions !== "off") {
      memoryReceipts = new MemoryTurnReceiptStore(join(options.dataDir, "memory-turn-receipts.db"));
      const decisionPersona =
        memoryConfig.decisions === "full"
          ? await (async () => {
              const { pack } = await loadPack(memoryConfig.decisionPersonaId!);
              const resolution = resolveVariants(pack, {
                surface: "memory",
                manualEnabled: [],
                manualDisabled: [],
                currentUserText: "",
              });
              const staticPrefix = resolution.blocks.map((block) => block.content).join("\n\n");
              return { staticPrefix, sha256: sha256hex(staticPrefix) };
            })()
          : undefined;
      memoryDecisions = await createMnemosyneDecisionRuntime({
        dbPath: memoryConfig.dbPath,
        backlogPath: join(options.dataDir, "memory-decision-backlog.db"),
        transcriptDbPath,
        receipts: memoryReceipts,
        transcriptStore: store,
        mode: memoryConfig.decisions,
        policyId: memoryConfig.policyId!,
        ...(memoryConfig.decisions === "full"
          ? {
              decisionProvider: containedModelProvider(memoryConfig.decisionProviderId!),
              decisionPersona: decisionPersona!,
              policy: {
                policyId: memoryConfig.policyId!,
                authorityRef: memoryConfig.authorityRef!,
                effectiveFrom: memoryConfig.effectiveFrom!,
              },
            }
          : {}),
        audit: memoryAudit,
        ...(options.memoryPackageLoader === undefined ? {} : { loadPackage: options.memoryPackageLoader }),
        now: () => new Date(clock.now().epochMs),
      });
      await memoryDecisions.recoverPendingReceipts();
    }
  }

  async function memoryDelivered(notice: DeliveredTurnNotice): Promise<void> {
    await memoryDecisions?.enqueueDeliveredTurn(notice.turnId);
  }

  /**
   * Build one user/proactive turn's shared host context. Web and Telegram call
   * this exact function; there is no second memory/persona assembly path.
   */
  async function buildTurn(
    conversationId: string,
    userText?: string,
    excludeTurnId?: string,
  ) {
    const conversation = await store.getConversation(conversationId);
    const { pack } = await loadPack(conversation.personaId);
    const resolution = resolveVariants(pack, {
      surface: conversation.surface,
      manualEnabled: conversation.manualEnabled,
      manualDisabled: conversation.manualDisabled,
      currentUserText: userText ?? "",
    });
    publish({ kind: "variants", conversationId, detail: resolution.metadata });
    const { scene, variantSha256 } = deriveMemoryScene(resolution);

    const active = await situations.active(nowIso());
    const messages = await store.listMessages(conversationId);
    const history: HistoryRecord[] = messages
      .filter(
        (m) =>
          m.state === "delivered" &&
          (excludeTurnId === undefined || m.externalTurnId !== excludeTurnId),
      )
      .map((m) => ({ id: m.id, role: m.role, text: m.text, atIso: m.createdAtIso }));

    const assembled = assembleContext({
      items: [
        ...resolution.blocks.map((b) => ({ source: "persona-base" as const, content: b.content })),
        ...active.map((s) => ({ source: "current-situation" as const, content: s.text })),
        ...history.map((h) => ({
          source: "recent-transcript" as const,
          content: `${h.role}: ${h.text}`,
          atIso: h.atIso,
        })),
        ...(userText === undefined
          ? []
          : [{ source: "current-user-message" as const, content: userText }]),
      ],
      budgetTokens: 8000,
      estimate: estimateTokens,
      historyRequested: false,
      historyRead: history.length > 0,
    });
    publish({ kind: "context", conversationId, detail: assembled.report });

    const personaText = resolution.blocks.map((b) => b.content).join("\n\n");
    // Situations are USER-AUTHORED free text landing inside the system
    // prompt - exactly the surface the delimiter guard exists for. The body
    // travels in an explicit untrusted block whose delimiters it cannot
    // forge, and the standing one-line rule accompanies it.
    const situationText =
      active.length === 0
        ? ""
        : `\n\nCurrent situation, stated by the user:\n${renderUntrustedBlock(
            "current-situation",
            active.map((s) => `- ${s.text}`).join("\n"),
          )}\n\n${UNTRUSTED_PREAMBLE}`;
    const now = clock.now();

    let memoryText: string | undefined;
    let selectedIds: readonly string[] = [];
    let priorVersions: Readonly<Record<string, number>> = {};
    if (userText !== undefined && memoryContextProvider !== undefined) {
      const recalled = await memoryContextProvider.retrieve(userText, nowIso(), scene);
      if (recalled.status === "ok") {
        memoryText = recalled.text;
        selectedIds = recalled.selectedIds;
        priorVersions = recalled.priorVersions;
        publish({
          kind: "memory",
          conversationId,
          detail: { status: "ok", selected: selectedIds.length, scene: scene.mode },
        });
      } else {
        publish({
          kind: "memory",
          conversationId,
          detail: { status: "degraded", scene: scene.mode },
        });
      }
    }

    return {
      systemPrompt:
        `${personaText}${situationText}\n\nThe current time is ${now.display} (${now.timeZone}).`,
      history,
      scene,
      variantSha256,
      memoryText,
      selectedIds,
      priorVersions,
      sourceTime: nowIso(),
    };
  }

  async function buildUserRequest(
    conversationId: string,
    providerTurnId: string,
    userText: string,
    durableTurnId: string,
  ): Promise<ModelRequest> {
    const built = await buildTurn(conversationId, userText, durableTurnId);
    const context =
      built.memoryText === undefined
        ? []
        : [{ kind: "retrieved-memory" as const, text: built.memoryText }];
    if (memoryReceipts !== undefined) {
      memoryReceipts.record({
        turnId: durableTurnId,
        conversationId,
        variantSha256: built.variantSha256,
        scene: built.scene,
        selectedIds: built.selectedIds,
        priorVersions: built.priorVersions,
        sourceTime: built.sourceTime,
      });
    }
    return {
      conversationId,
      turnId: providerTurnId,
      systemPrompt:
        context.length === 0
          ? built.systemPrompt
          : `${built.systemPrompt}\n\n${HOST_CONTEXT_SYSTEM_RULE}`,
      messages: [
        ...built.history.map((h) => ({ role: h.role, text: h.text })),
        contextualizeCurrentMessage({ role: "user", text: userText }, context),
      ],
    };
  }

  const coordinators = new Map<string, TurnCoordinator>();
  function coordinatorFor(profileId: string): TurnCoordinator {
    let coordinator = coordinators.get(profileId);
    if (coordinator === undefined) {
      coordinator = createTurnCoordinator({
        store,
        provider: containedModelProvider(profileId),
        deliver: async (_surface, conversationKey, text) => {
          publish({ kind: "assistant-text", conversationId: conversationKey, detail: { text } });
        },
        nowIso,
        ...(memoryDecisions === undefined ? {} : { onDelivered: memoryDelivered }),
      });
      coordinators.set(profileId, coordinator);
    }
    return coordinator;
  }

  // --- telegram surface lifecycle -------------------------------------------
  let telegramSurface: TelegramSurface | undefined;
  function telegramConfigured(): boolean {
    return (
      telegramConfig.defaultProviderProfileId.length > 0 &&
      telegramConfig.defaultPersonaId.length > 0 &&
      telegramConfig.allowedUserIds.length > 0
    );
  }
  function telegramSurfaceFor(): TelegramSurface {
    if (telegramSurface === undefined) {
      telegramSurface = createTelegramSurface({
        config: {
          enabled: telegramConfig.enabled,
          tokenSecretId: telegramConfig.tokenSecretId,
          allowedUserIds: telegramConfig.allowedUserIds,
          defaultProviderProfileId: telegramConfig.defaultProviderProfileId,
          defaultPersonaId: telegramConfig.defaultPersonaId,
          defaultVariants: telegramConfig.defaultVariants,
        },
        secretStore,
        store,
        provider: containedModelProvider(telegramConfig.defaultProviderProfileId),
        // The SAME assembly the web surface gets - persona, variants,
        // situations, memory, trusted time - and the same containment +
        // sanitising at the delivery boundary.
        buildRequest: (conversationId, turnId, userText, durableTurnId) =>
          buildUserRequest(conversationId, turnId, userText, durableTurnId),
        ...(memoryDecisions === undefined ? {} : { onTurnDelivered: memoryDelivered }),
        ...(sttAdapter === undefined ? {} : { stt: sttAdapter, attachmentDir: attachmentsDir }),
        renderForDelivery: (text) => {
          const contained = containModelOutput(text, {
            providerKind: telegramConfig.defaultProviderProfileId,
            nowIso,
            sha256: sha256hex,
          });
          const sanitized = sanitizeReplyText(contained.ok ? contained.text : "");
          return sanitized.ok ? sanitized.text : "";
        },
        nowIso,
        ...(options.telegramApiOrigin === undefined ? {} : { apiOrigin: options.telegramApiOrigin }),
      });
    }
    return telegramSurface;
  }

  // --- routes ---------------------------------------------------------------
  const router = new Router();
  const startedAt = Date.now();

  router.on("GET", `${API_PREFIX}/health`, async ({ res }) => {
    sendJson(res, 200, {
      ok: true,
      version: DAEMON_VERSION,
      apiVersion: API_VERSION,
      uptimeMs: Date.now() - startedAt,
    });
  });

  router.on("GET", `${API_PREFIX}/schema`, async ({ res }) => {
    sendJson(res, 200, {
      apiVersion: API_VERSION,
      sessionHeader: "x-delos-session",
      routes: SCHEMA_ROUTES,
    });
  });

  // providers
  router.on("GET", `${API_PREFIX}/providers`, async ({ res }) => {
    sendJson(res, 200, { profiles });
  });
  router.on(
    "POST",
    `${API_PREFIX}/providers`,
    async ({ res, body }) => {
      const profile = parseProviderProfile(body);
      if (profiles.some((p) => p.id === profile.id)) {
        throw new HttpError(409, "conflict", "A profile with that id exists.");
      }
      profiles.push(profile);
      refreshMapping();
      await saveProfiles();
      sendJson(res, 201, { profile });
    },
    true,
  );
  router.on(
    "PUT",
    `${API_PREFIX}/providers/:id`,
    async ({ res, params, body }) => {
      const profile = parseProviderProfile(body);
      if (profile.id !== params["id"]) {
        throw new HttpError(400, "invalid", "The profile id cannot change in place.");
      }
      const index = profiles.findIndex((p) => p.id === profile.id);
      if (index === -1) throw new HttpError(404, "not_found", "No such provider profile.");
      profiles[index] = profile;
      refreshMapping();
      await saveProfiles();
      sendJson(res, 200, { profile });
    },
    true,
  );
  router.on("DELETE", `${API_PREFIX}/providers/:id`, async ({ res, params }) => {
    const index = profiles.findIndex((p) => p.id === params["id"]);
    if (index === -1) throw new HttpError(404, "not_found", "No such provider profile.");
    profiles.splice(index, 1);
    await saveProfiles();
    sendJson(res, 200, { deleted: true });
  });
  router.on("POST", `${API_PREFIX}/providers/:id/test`, async ({ res, params }) => {
    const report = await testProviderConnection(providerFor(params["id"]!));
    sendJson(res, report.ok ? 200 : 502, report);
  });

  // personas
  router.on("GET", `${API_PREFIX}/personas`, async ({ res }) => {
    const { shipped, user } = await listPackIds();
    const describe = async (id: string, isShipped: boolean) => {
      const { pack } = await loadPack(id);
      return {
        id,
        displayName: pack.manifest.displayName,
        description: pack.manifest.description,
        shipped: isShipped,
        variants: pack.manifest.variants.map((v) => ({
          id: v.id,
          displayName: v.displayName,
          policy: v.policy,
          description: v.description,
        })),
      };
    };
    sendJson(res, 200, {
      personas: [
        ...(await Promise.all(shipped.map((id) => describe(id, true)))),
        ...(await Promise.all(user.filter((u) => !shipped.includes(u)).map((id) => describe(id, false)))),
      ],
    });
  });
  router.on("GET", `${API_PREFIX}/personas/:id`, async ({ res, params }) => {
    const { pack, shipped } = await loadPack(params["id"]!);
    sendJson(res, 200, {
      manifest: pack.manifest,
      shipped,
      blocks: [...pack.blocks.entries()].map(([path, content]) => ({ path, content })),
    });
  });
  router.on(
    "POST",
    `${API_PREFIX}/personas`,
    async ({ res, body }) => {
      const input = body as {
        mode: "wizard" | "paste" | "zip";
        wizard?: Parameters<typeof createPackFromWizard>[0];
        pastedId?: string;
        pasted?: string;
        zipBase64?: string;
      };
      let pack: LoadedPersonaPack;
      if (input.mode === "wizard" && input.wizard) pack = createPackFromWizard(input.wizard);
      else if (input.mode === "paste" && input.pastedId && input.pasted) {
        pack = createPackFromPastedPrompt(input.pastedId, input.pasted);
      } else if (input.mode === "zip" && input.zipBase64) {
        pack = importPackZip(Buffer.from(input.zipBase64, "base64"));
      } else throw new HttpError(400, "invalid", "Unsupported persona creation input.");

      const { shipped, user } = await listPackIds();
      if (shipped.includes(pack.manifest.id) || user.includes(pack.manifest.id)) {
        throw new HttpError(409, "conflict", "A persona with that id exists.");
      }
      await writeUserPack(pack);
      sendJson(res, 201, { id: pack.manifest.id });
    },
    true,
  );
  router.on(
    "POST",
    `${API_PREFIX}/personas/:id/duplicate`,
    async ({ res, params, body }) => {
      const newId = (body as { newId?: string })?.newId;
      if (typeof newId !== "string") throw new HttpError(400, "invalid", "newId is required.");
      const { pack } = await loadPack(params["id"]!);
      const copy = duplicatePack(pack, newId);
      const { shipped, user } = await listPackIds();
      if (shipped.includes(newId) || user.includes(newId)) {
        throw new HttpError(409, "conflict", "A persona with that id exists.");
      }
      await writeUserPack(copy);
      sendJson(res, 201, { id: newId });
    },
    true,
  );
  router.on("GET", `${API_PREFIX}/personas/:id/export`, async ({ res, params }) => {
    const { pack } = await loadPack(params["id"]!);
    const zip = exportPackZip(pack);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": `attachment; filename="${pack.manifest.id}.zip"`,
      "Cache-Control": "no-store",
    });
    res.end(zip);
  });
  router.on("DELETE", `${API_PREFIX}/personas/:id`, async ({ res, params }) => {
    const { user } = await listPackIds();
    if (!user.includes(params["id"]!)) {
      throw new HttpError(400, "invalid", "Shipped personas cannot be deleted; duplicate and edit instead.");
    }
    await rm(join(userPersonaDir, params["id"]!), { recursive: true, force: true });
    sendJson(res, 200, { deleted: true });
  });

  // situations
  router.on("GET", `${API_PREFIX}/situations`, async ({ res }) => {
    sendJson(res, 200, { active: await situations.active(nowIso()), all: await situations.inspect() });
  });
  router.on(
    "POST",
    `${API_PREFIX}/situations`,
    async ({ res, body }) => {
      const input = body as { text?: string; expiresAtIso?: string };
      if (!input.text || !input.expiresAtIso) throw new HttpError(400, "invalid", "text and expiresAtIso are required.");
      const created = await situations.create(input.text, nowIso(), input.expiresAtIso);
      await persistSituations();
      sendJson(res, 201, { situation: created });
    },
    true,
  );
  router.on(
    "PUT",
    `${API_PREFIX}/situations/:id`,
    async ({ res, params, body }) => {
      const input = body as { text?: string; expiresAtIso?: string };
      if (!input.text || !input.expiresAtIso) throw new HttpError(400, "invalid", "text and expiresAtIso are required.");
      const next = await situations.supersede(params["id"]!, input.text, nowIso(), input.expiresAtIso);
      await persistSituations();
      sendJson(res, 200, { situation: next });
    },
    true,
  );
  router.on("POST", `${API_PREFIX}/situations/:id/end`, async ({ res, params }) => {
    await situations.end(params["id"]!, nowIso());
    await persistSituations();
    sendJson(res, 200, { ended: true });
  });
  router.on("DELETE", `${API_PREFIX}/situations/:id`, async ({ res, params }) => {
    await situations.delete(params["id"]!);
    sendJson(res, 200, { deleted: true });
  });

  // conversations
  router.on("GET", `${API_PREFIX}/conversations`, async ({ res }) => {
    sendJson(res, 200, { conversations: await store.listConversations(true) });
  });
  router.on(
    "POST",
    `${API_PREFIX}/conversations`,
    async ({ res, body }) => {
      const input = body as { title?: string; personaId?: string; providerProfileId?: string };
      if (!input.title || !input.personaId || !input.providerProfileId) {
        throw new HttpError(400, "invalid", "title, personaId and providerProfileId are required.");
      }
      await loadPack(input.personaId); // 404 early on a bad persona
      providerFor(input.providerProfileId); // 404 early on a bad profile
      const conversation = await store.createConversation(
        { title: input.title, personaId: input.personaId, providerProfileId: input.providerProfileId, surface: "web" },
        nowIso(),
      );
      sendJson(res, 201, { conversation });
    },
    true,
  );
  router.on(
    "PATCH",
    `${API_PREFIX}/conversations/:id`,
    async ({ res, params, body }) => {
      const input = body as {
        title?: string;
        archived?: boolean;
        manualEnabled?: string[];
        manualDisabled?: string[];
      };
      if (input.title !== undefined) await store.renameConversation(params["id"]!, input.title, nowIso());
      if (input.archived !== undefined) await store.archiveConversation(params["id"]!, input.archived, nowIso());
      if (input.manualEnabled !== undefined || input.manualDisabled !== undefined) {
        const current = await store.getConversation(params["id"]!);
        await store.setConversationVariants(
          params["id"]!,
          input.manualEnabled ?? current.manualEnabled,
          input.manualDisabled ?? current.manualDisabled,
          nowIso(),
        );
      }
      sendJson(res, 200, { conversation: await store.getConversation(params["id"]!) });
    },
    true,
  );
  router.on("DELETE", `${API_PREFIX}/conversations/:id`, async ({ res, params }) => {
    await store.deleteConversation(params["id"]!);
    sendJson(res, 200, { deleted: true });
  });
  router.on("GET", `${API_PREFIX}/conversations/:id/messages`, async ({ res, params }) => {
    sendJson(res, 200, { messages: await store.listMessages(params["id"]!) });
  });
  router.on("GET", `${API_PREFIX}/conversations/:id/export`, async ({ res, params }) => {
    const exported = await store.exportConversation(params["id"]!);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="conversation-${params["id"]}.json"`,
      "Cache-Control": "no-store",
    });
    res.end(exported);
  });

  // history
  router.on(
    "POST",
    `${API_PREFIX}/conversations/:id/history-query`,
    async ({ res, params, body }) => {
      const messages = await store.listMessages(params["id"]!);
      const reader = createInMemoryHistoryReader(() =>
        messages
          .filter((m) => m.state === "delivered")
          .map((m) => ({ id: m.id, role: m.role, text: m.text, atIso: m.createdAtIso })),
      );
      const result = await reader.read((body as { query: HistoryQuery }).query);
      sendJson(res, 200, result);
    },
    true,
  );

  // messages / turns
  router.on(
    "POST",
    `${API_PREFIX}/conversations/:id/messages`,
    async ({ res, params, body }) => {
      const input = body as { text?: string; idempotencyKey?: string };
      if (!input.text || !input.idempotencyKey) {
        throw new HttpError(400, "invalid", "text and idempotencyKey are required.");
      }
      const conversation = await store.getConversation(params["id"]!);
      const coordinator = coordinatorFor(conversation.providerProfileId);
      publish({ kind: "turn-accepted", conversationId: conversation.id });
      userTurnsInFlight++;
      try {
        const outcome = await coordinator.submit({
          surface: "web",
          externalConversationKey: conversation.id,
          externalTurnKey: input.idempotencyKey,
          conversationId: conversation.id,
          userText: input.text,
          buildRequest: (userText, durableTurnId) =>
            buildUserRequest(conversation.id, input.idempotencyKey!, userText, durableTurnId),
        });
        if (outcome.kind === "completed") {
          // Containment ran BEFORE persistence on the provider seam; this
          // second pass is defence in depth and a no-op on clean text.
          const contained = containModelOutput(outcome.assistantText, {
            providerKind: conversation.providerProfileId,
            nowIso,
            sha256: sha256hex,
          });
          const sanitized = sanitizeReplyText(contained.ok ? contained.text : "");
          const text = sanitized.ok ? sanitized.text : "";
          publish({ kind: "turn-completed", conversationId: conversation.id });
          sendJson(res, 200, { outcome: { ...outcome, assistantText: text }, containment: contained.records });
          return;
        }
        publish({ kind: "turn-failed", conversationId: conversation.id, detail: outcome });
        sendJson(res, 200, { outcome });
      } finally {
        userTurnsInFlight--;
      }
    },
    true,
  );
  router.on("POST", `${API_PREFIX}/conversations/:id/cancel`, async ({ res }) => {
    sendJson(res, 501, {
      supported: false,
      reason: "Cancellation of an in-flight provider call is not wired through the coordinator yet.",
    });
  });

  // SSE
  router.on("GET", `${API_PREFIX}/conversations/:id/events`, async ({ res, params }) => {
    const id = params["id"]!;
    await store.getConversation(id);
    const connection = openSse(res);
    let set = listeners.get(id);
    if (set === undefined) {
      set = new Set();
      listeners.set(id, set);
    }
    set.add(connection);
    res.on("close", () => {
      set!.delete(connection);
      connection.close();
    });
  });

  // settings / diagnostics / phase-5 stubs (honest)
  router.on("GET", `${API_PREFIX}/settings`, async ({ res }) => {
    sendJson(res, 200, {
      dataDir: options.dataDir,
      timeZone: clock.timeZone,
      version: DAEMON_VERSION,
    });
  });
  router.on("GET", `${API_PREFIX}/diagnostics`, async ({ res }) => {
    const conversations = await store.listConversations(true);
    sendJson(res, 200, {
      ok: true,
      uptimeMs: Date.now() - startedAt,
      conversationCount: conversations.length,
      providerProfiles: profiles.map((p) => ({ id: p.id, kind: p.kind, enabled: p.enabled })),
      recoverableTurns: (await store.listRecoverableTurns()).length,
      memory:
        memoryConfig.backend === "off"
          ? { backend: "off", decisions: "off" }
          : {
              backend: "mnemosyne",
              decisions: memoryConfig.decisions,
              ...(memoryDecisions === undefined ? {} : { decisionRuntime: memoryDecisions.status() }),
            },
    });
  });
  router.on("GET", `${API_PREFIX}/telegram/status`, async ({ res }) => {
    // The config echo is non-secret by construction: a reference and an
    // environment variable NAME, never a token.
    if (!telegramConfigured()) {
      sendJson(res, 200, {
        enabled: telegramConfig.enabled,
        running: false,
        configured: false,
        config: telegramConfig,
      });
      return;
    }
    sendJson(res, 200, { ...telegramSurfaceFor().status(), config: telegramConfig });
  });
  router.on(
    "PUT",
    `${API_PREFIX}/telegram/config`,
    async ({ res, body }) => {
      const parsed = parseTelegramConfigHttp(body);
      if (telegramSurface !== undefined) {
        await telegramSurface.stop();
        telegramSurface = undefined;
      }
      telegramConfig = parsed;
      await saveTelegramConfig();
      refreshMapping();
      sendJson(res, 200, { config: telegramConfig });
    },
    true,
  );
  router.on("POST", `${API_PREFIX}/telegram/start`, async ({ res }) => {
    if (!telegramConfigured()) {
      throw new HttpError(
        400,
        "invalid",
        "Telegram needs a default provider profile, a default persona, and at least one allowed user id.",
      );
    }
    sendJson(res, 200, { ...(await telegramSurfaceFor().start()), config: telegramConfig });
  });
  router.on("POST", `${API_PREFIX}/telegram/stop`, async ({ res }) => {
    await telegramSurface?.stop();
    sendJson(res, 200, { stopped: true });
  });

  // --- attachments: the honest capability surface ---------------------------
  router.on("GET", `${API_PREFIX}/attachments/status`, async ({ res }) => {
    sendJson(res, 200, {
      stt: sttAdapter === undefined
        ? { configured: false, detail: "No local transcriber is configured; voice input is unsupported." }
        : { configured: true, name: sttAdapter.name },
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      imageInput: {
        supported: false,
        detail: "No configured provider has evidenced image capability; image input is refused truthfully.",
      },
    });
  });

  // --- egress policy: status, configuration, and the single judgement seam --
  router.on("GET", `${API_PREFIX}/egress/status`, async ({ res }) => {
    sendJson(res, 200, describeEgress(egressConfig));
  });
  router.on(
    "PUT",
    `${API_PREFIX}/egress/config`,
    async ({ res, body }) => {
      const input = body as { enabled?: boolean; consent?: boolean; allowedHosts?: unknown };
      if (input.enabled === true) {
        if (input.consent !== true) {
          throw new HttpError(
            400,
            "invalid",
            "Enabling retrieval requires explicit consent in the same request.",
          );
        }
        egressConfig = parseEgressConfig({
          enabled: true,
          consentGrantedAtIso: nowIso(),
          allowedHosts: input.allowedHosts,
        });
      } else {
        // Disabling drops the consent record: re-enabling needs fresh consent.
        egressConfig = { ...EGRESS_DEFAULTS };
      }
      await saveEgressConfig();
      sendJson(res, 200, describeEgress(egressConfig));
    },
    true,
  );
  router.on(
    "POST",
    `${API_PREFIX}/egress/judge`,
    async ({ res, body }) => {
      const input = body as { url?: string };
      if (typeof input.url !== "string") {
        throw new HttpError(400, "invalid", "url is required.");
      }
      sendJson(res, 200, evaluateEgress(input.url, egressConfig));
    },
    true,
  );

  // --- proactive: status, config, resume, and the explicit tick seam --------
  async function derivedProactiveState(): Promise<ProactiveState> {
    // The store is the single source of truth for "when did the user last
    // speak" - every surface writes into it, so no per-surface hook exists
    // to forget. A user message newer than the last proactive send means
    // the silence ended: backoff and pause reset.
    let state = proactiveState;
    if (proactiveConfig.conversationId !== undefined) {
      try {
        const messages = await store.listMessages(proactiveConfig.conversationId);
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (lastUser !== undefined) {
          state = { ...state, lastUserMessageAtIso: lastUser.createdAtIso };
          if (
            state.lastProactiveAtIso !== undefined &&
            lastUser.createdAtIso > state.lastProactiveAtIso
          ) {
            state = recordUserMessage(state, lastUser.createdAtIso);
          }
        }
      } catch {
        // A missing conversation keeps the persisted state; the tick itself
        // reports the configuration problem honestly.
      }
    }
    return state;
  }

  router.on("GET", `${API_PREFIX}/proactive/status`, async ({ res }) => {
    const state = await derivedProactiveState();
    // The preview decision uses centre-of-band jitter so the display is
    // deterministic; a real tick draws real randomness.
    const preview = decideProactive({
      config: proactiveConfig,
      state,
      nowIso: nowIso(),
      userTurnInFlight: userTurnsInFlight > 0,
      random: () => 0.5,
    });
    sendJson(res, 200, { config: proactiveConfig, state, preview });
  });
  router.on(
    "PUT",
    `${API_PREFIX}/proactive/config`,
    async ({ res, body }) => {
      const parsed = parseProactiveConfig(body);
      if (parsed.enabled && parsed.conversationId === undefined) {
        throw new HttpError(400, "invalid", "Enabling proactive messaging needs a target conversation.");
      }
      if (parsed.enabled) await store.getConversation(parsed.conversationId!); // 404 early
      proactiveConfig = parsed;
      await saveProactive();
      sendJson(res, 200, { config: proactiveConfig });
    },
    true,
  );
  router.on("POST", `${API_PREFIX}/proactive/resume`, async ({ res }) => {
    proactiveState = resumeProactive(proactiveState);
    await saveProactive();
    sendJson(res, 200, { state: proactiveState });
  });
  router.on(
    "POST",
    `${API_PREFIX}/proactive/tick`,
    async ({ res, body }) => {
      const input = (body ?? {}) as { nowIso?: string; random?: number };
      const at = typeof input.nowIso === "string" ? input.nowIso : nowIso();
      const draw =
        typeof input.random === "number" && input.random >= 0 && input.random < 1
          ? () => input.random as number
          : Math.random;
      const state = await derivedProactiveState();
      const decision = decideProactive({
        config: proactiveConfig,
        state,
        nowIso: at,
        userTurnInFlight: userTurnsInFlight > 0,
        random: draw,
      });
      if (!decision.send) {
        proactiveState = state;
        await saveProactive();
        sendJson(res, 200, { decision, delivered: { desktop: false, telegram: false } });
        return;
      }

      const conversationId = proactiveConfig.conversationId!;
      const conversation = await store.getConversation(conversationId);
      const built = await buildTurn(conversationId); // NO user text: not user speech
      const generated = await containedModelProvider(conversation.providerProfileId).generate({
        conversationId,
        turnId: `proactive-${at}`,
        systemPrompt:
          `${built.systemPrompt}\n\nThis is a runtime-initiated ${decision.policy ?? "proactive"} ` +
          `check-in. The user has not written anything new; nothing in this turn is user speech. ` +
          `Write one brief, warm message picking the conversation back up.`,
        messages: built.history.map((h) => ({ role: h.role, text: h.text })),
      });
      if (!generated.ok) {
        sendJson(res, 200, {
          decision,
          delivered: { desktop: false, telegram: false },
          failure: "The provider call failed; nothing was stored or delivered.",
        });
        return;
      }

      const echo = guardProactiveEcho(generated.text, state);
      if (!echo.ok) {
        proactiveState = state;
        await saveProactive();
        sendJson(res, 200, {
          decision: { ...decision, send: false, reason: echo.reason },
          delivered: { desktop: false, telegram: false },
        });
        return;
      }

      // Delivery per surface preference. Desktop = the daemon's own SSE
      // stream. Telegram = only when the target conversation is a telegram
      // conversation whose chat this bot already talks to.
      const delivered = { desktop: false, telegram: false };
      if (proactiveConfig.delivery.desktop) {
        publish({ kind: "assistant-text", conversationId, detail: { text: generated.text, proactive: true } });
        delivered.desktop = true;
      }
      if (proactiveConfig.delivery.telegram) {
        // The chat mapping IS the conversation title, exactly as the
        // telegram surface maintains it.
        const chatMatch =
          conversation.surface === "telegram" ? /^Telegram chat (-?\d+)$/.exec(conversation.title) : null;
        if (chatMatch !== null && telegramSurface !== undefined && telegramSurface.status().running) {
          await telegramSurface.sendText(Number(chatMatch[1]), generated.text);
          delivered.telegram = true;
        }
      }

      if (delivered.desktop || delivered.telegram) {
        await store.appendMessage(
          { conversationId, role: "assistant", text: generated.text, state: "delivered" },
          at,
        );
        proactiveState = recordProactiveSent(state, generated.text, at, proactiveConfig.pauseAfterUnanswered);
        await saveProactive();
      }
      sendJson(res, 200, { decision, delivered });
    },
    true,
  );
  router.on("GET", `${API_PREFIX}/delegated/status`, async ({ res }) => {
    // REAL detection - version probes of the installed tools - with honest
    // integration status: the protocol contract is proven against synthetic
    // fakes, and stays DEGRADED until observed against an installed version.
    // No account identifier and no login state is read or reported.
    const commandFor = (kind: string, fallback: string): string => {
      const delegatedProfile = profiles.find((p) => p.kind === kind && p.executablePath !== undefined);
      return delegatedProfile?.executablePath ?? fallback;
    };
    const [codex, claude] = await Promise.all([
      detectExecutable(runToCompletion, commandFor("delegated-codex", DEFAULT_CODEX_COMMAND), delegatedWorkDir),
      detectExecutable(
        runToCompletion,
        commandFor("delegated-claude-code", DEFAULT_CLAUDE_COMMAND),
        delegatedWorkDir,
      ),
    ]);
    const report = (detection: { installed: boolean; version?: string; detail: string }) => ({
      ...detection,
      // Auth state is inspected at TURN time through each tool's official
      // surface (never through its files); this status endpoint does not
      // spawn the tools to probe it.
      authState: "inspected-per-turn",
      integration: detection.installed ? "detected-untested" : "not-installed",
      note:
        "The tool owns its own login; Delos inspects auth state only through " +
        "the tool's official surface during turns and never reads its " +
        "credential files. Protocol behaviour is proven against synthetic " +
        "contract fakes and is degraded until observed against this " +
        "installed version.",
    });
    sendJson(res, 200, { codex: report(codex), claudeCode: report(claude) });
  });

  // --- full backup / restore -------------------------------------------------
  async function userPersonaFiles(): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        const full = join(dir, name);
        const entryStat = await stat(full);
        if (entryStat.isDirectory()) await walk(full, `${prefix}${name}/`);
        else out.set(`personas/${prefix}${name}`, await readFile(full, "utf8"));
      }
    };
    await walk(userPersonaDir, "");
    return out;
  }

  function telegramDocument(): string {
    return JSON.stringify({ schemaVersion: 1, ...telegramConfig }, null, 2);
  }
  function providersDocument(): string {
    return JSON.stringify({ schemaVersion: 1, profiles }, null, 2);
  }

  router.on("GET", `${API_PREFIX}/backup`, async ({ res }) => {
    const zip = createBackupZip({
      transcripts: await store.exportEverything(),
      situations: await situations.exportAll(),
      providers: providersDocument(),
      telegram: telegramDocument(),
      personaFiles: await userPersonaFiles(),
      appVersion: DAEMON_VERSION,
      transcriptSchemaVersion: (await store.integrityCheck()).schemaVersion,
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": 'attachment; filename="delos-backup.zip"',
      "Cache-Control": "no-store",
    });
    res.end(zip);
  });
  router.on(
    "POST",
    `${API_PREFIX}/restore`,
    async ({ res, body }) => {
      const input = body as { zipBase64?: string; mode?: string; policy?: string };
      if (typeof input.zipBase64 !== "string" || input.zipBase64.length === 0) {
        throw new HttpError(400, "invalid", "restore needs zipBase64.");
      }
      let zip: Buffer;
      try {
        zip = Buffer.from(input.zipBase64, "base64");
      } catch {
        throw new HttpError(400, "invalid", "zipBase64 is not decodable.");
      }
      try {
        if (input.mode === "inspect") {
          sendJson(res, 200, { preview: previewBackup(zip) });
          return;
        }
        const policy = input.policy === "merge-skip" ? "merge-skip" : "replace";
        const result = await applyBackup(zip, policy, {
          store,
          situations,
          secretStore,
          dataDir: options.dataDir,
          personaDir: userPersonaDir,
        });
        // The daemon's in-memory state now lags the restored files: reload
        // profiles and telegram config, drop cached coordinators and the
        // telegram surface, and persist the situations file.
        try {
          const raw = JSON.parse(await readFile(profilesPath, "utf8")) as { profiles: unknown[] };
          profiles = [...parseProviderProfiles(raw.profiles)];
        } catch {
          profiles = [];
        }
        try {
          telegramConfig = parseTelegramConfigHttp(JSON.parse(await readFile(telegramPath, "utf8")));
        } catch {
          telegramConfig = { ...TELEGRAM_DEFAULTS };
        }
        refreshMapping();
        coordinators.clear();
        if (telegramSurface !== undefined) {
          await telegramSurface.stop();
          telegramSurface = undefined;
        }
        await persistSituations();
        sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof BackupError) {
          throw new HttpError(400, error.code, error.message);
        }
        throw error;
      }
    },
    // Sized so every archive the backup format can PRODUCE (256 MiB) fits
    // through the only restore transport, with base64 and JSON overhead.
    { maxBytes: 384 * 1024 * 1024 },
  );

  // --- doctor ----------------------------------------------------------------
  async function doctorReport(online: boolean): Promise<import("../../core/services/doctor.js").DoctorReport> {
    const { shipped, user } = await listPackIds();
    const loaded: string[] = [];
    const failed: string[] = [];
    for (const id of [...shipped, ...user]) {
      try {
        await loadPack(id);
        loaded.push(id);
      } catch {
        failed.push(id);
      }
    }
    const activePersonaIds = [
      ...new Set((await store.listConversations(false)).map((c) => c.personaId)),
    ];
    const codexProfile = profiles.find((p) => p.kind === "delegated-codex");
    const checks = buildDoctorChecks({
      appVersion: DAEMON_VERSION,
      apiVersion: API_VERSION,
      dataDir: options.dataDir,
      store,
      profiles,
      secretStore,
      telegramConfig,
      secretStoreNames: [...(options.secretStores ?? []).map((s) => s.name), "environment"],
      personas: { loaded, failed },
      activePersonaIds,
      boundAddress: origin.replace("http://", ""),
      ...(online
        ? {
            providerProbe: async (profileId: string) => {
              const report = await testProviderConnection(providerFor(profileId));
              return report.ok ? { ok: true } : { ok: false, code: report.error.code };
            },
          }
        : {}),
      ...(online && codexProfile !== undefined
        ? {
            codexAuthProbe: () => inspectCodexAuth(codexProfile, { workDir: delegatedWorkDir }),
          }
        : {}),
      ...(online && telegramConfig.enabled
        ? {
            telegramProbe: async () => {
              const status = await telegramSurfaceFor().probe();
              return {
                ...(status.webhookConflict === undefined ? {} : { webhookConflict: status.webhookConflict }),
                ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
              };
            },
          }
        : {}),
    });
    return runDoctor(checks, nowIso());
  }

  router.on("GET", `${API_PREFIX}/doctor`, async ({ req, res }) => {
    const online = new URL(req.url ?? "/", origin || "http://127.0.0.1").searchParams.get("online") === "1";
    sendJson(res, 200, await doctorReport(online));
  });
  router.on("GET", `${API_PREFIX}/doctor/report`, async ({ res }) => {
    const redacted = redactDoctorReport(await doctorReport(false));
    const text = JSON.stringify(redacted, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="delos-doctor-report.json"',
      "Cache-Control": "no-store",
    });
    res.end(text);
  });

  // --- server ---------------------------------------------------------------
  const sessionToken = randomBytes(32).toString("hex");
  let origin = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      if (url.pathname.startsWith(API_PREFIX)) {
        if (!gate(req, res, { origin, token: sessionToken })) return;
        const handled = await router.dispatch(req, res, url.pathname);
        if (!handled) sendError(res, 404, "not_found", "No such API route.");
        return;
      }
      await serveStatic(url.pathname, res);
    })().catch(() => {
      if (!res.writableEnded) sendError(res, 500, "internal", "The request failed inside the daemon.");
    });
  });

  async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<void> {
    // The web app. The session token is injected into the page the daemon
    // itself serves - the only page that can present the matching Origin.
    const staticDir = join(options.shippedPersonaDir, "..", "surfaces", "web", "static");
    const appDir = join(options.shippedPersonaDir, "..", "build", "surfaces", "web", "app");
    if (pathname === "/" || pathname === "/index.html") {
      try {
        const html = (await readFile(join(staticDir, "index.html"), "utf8")).replace(
          "__DELOS_SESSION__",
          sessionToken,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } catch {
        sendError(res, 404, "not_found", "The web application is not built.");
      }
      return;
    }
    // /app/<web/app|api-client>/<file>.js from the build tree, plus the
    // stylesheet. Allowlist-shaped: anything else on the static surface 404s.
    const safe = /^\/(app\/(?:web\/app|api-client)\/[A-Za-z0-9._-]+\.js|styles\.css)$/.exec(pathname);
    if (safe === null) {
      sendError(res, 404, "not_found", "Not found.");
      return;
    }
    const buildRoot = join(appDir, "..", "..");
    const file =
      pathname === "/styles.css"
        ? join(staticDir, "styles.css")
        : join(buildRoot, pathname.slice("/app/".length));
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        "Content-Type": pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      sendError(res, 404, "not_found", "Not found.");
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    sessionToken,
    async close(): Promise<void> {
      await telegramSurface?.stop();
      for (const set of listeners.values()) for (const c of set) c.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await memoryDecisions?.close();
      memoryReceipts?.close();
      await memoryContextProvider?.close?.();
      await store.close();
    },
  };
}

/** The machine-readable route inventory served at /api/v1/schema. */
const SCHEMA_ROUTES = [
  { method: "GET", path: "/api/v1/health" },
  { method: "GET", path: "/api/v1/schema" },
  { method: "GET", path: "/api/v1/providers" },
  { method: "POST", path: "/api/v1/providers" },
  { method: "PUT", path: "/api/v1/providers/:id" },
  { method: "DELETE", path: "/api/v1/providers/:id" },
  { method: "POST", path: "/api/v1/providers/:id/test" },
  { method: "GET", path: "/api/v1/personas" },
  { method: "GET", path: "/api/v1/personas/:id" },
  { method: "POST", path: "/api/v1/personas" },
  { method: "POST", path: "/api/v1/personas/:id/duplicate" },
  { method: "GET", path: "/api/v1/personas/:id/export" },
  { method: "DELETE", path: "/api/v1/personas/:id" },
  { method: "GET", path: "/api/v1/situations" },
  { method: "POST", path: "/api/v1/situations" },
  { method: "PUT", path: "/api/v1/situations/:id" },
  { method: "POST", path: "/api/v1/situations/:id/end" },
  { method: "DELETE", path: "/api/v1/situations/:id" },
  { method: "GET", path: "/api/v1/conversations" },
  { method: "POST", path: "/api/v1/conversations" },
  { method: "PATCH", path: "/api/v1/conversations/:id" },
  { method: "DELETE", path: "/api/v1/conversations/:id" },
  { method: "GET", path: "/api/v1/conversations/:id/messages" },
  { method: "GET", path: "/api/v1/conversations/:id/export" },
  { method: "POST", path: "/api/v1/conversations/:id/history-query" },
  { method: "POST", path: "/api/v1/conversations/:id/messages" },
  { method: "POST", path: "/api/v1/conversations/:id/cancel" },
  { method: "GET", path: "/api/v1/conversations/:id/events" },
  { method: "GET", path: "/api/v1/settings" },
  { method: "GET", path: "/api/v1/diagnostics" },
  { method: "GET", path: "/api/v1/telegram/status" },
  { method: "PUT", path: "/api/v1/telegram/config" },
  { method: "POST", path: "/api/v1/telegram/start" },
  { method: "POST", path: "/api/v1/telegram/stop" },
  { method: "GET", path: "/api/v1/egress/status" },
  { method: "PUT", path: "/api/v1/egress/config" },
  { method: "POST", path: "/api/v1/egress/judge" },
  { method: "GET", path: "/api/v1/attachments/status" },
  { method: "GET", path: "/api/v1/proactive/status" },
  { method: "PUT", path: "/api/v1/proactive/config" },
  { method: "POST", path: "/api/v1/proactive/resume" },
  { method: "POST", path: "/api/v1/proactive/tick" },
  { method: "GET", path: "/api/v1/delegated/status" },
  { method: "GET", path: "/api/v1/backup" },
  { method: "POST", path: "/api/v1/restore" },
  { method: "GET", path: "/api/v1/doctor" },
  { method: "GET", path: "/api/v1/doctor/report" },
] as const;
