import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { ModelProvider } from "../../core/ports/model-provider.js";
import type { TranscriptStore } from "../../core/ports/transcript-store.js";
import {
  genericMemoryReceiptMayActivate,
  MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
  resolveGenericMemoryIngressAuthority,
  type MemoryIngressAuthorityMode,
} from "./memory-ingress-authority.js";
import { MemoryTurnReceiptStore, type MemoryTurnReceipt } from "./memory-turn-receipts.js";
import {
  defaultMnemosynePackageLoader,
  MNEMOSYNE_PACKAGE_NAME,
  MnemosynePackageError,
  type MnemosynePackageLoader,
} from "./mnemosyne-package.js";

export type MemoryDecisionMode = "enqueue-only" | "full";

export interface MemoryDecisionPolicy {
  readonly policyId: string;
  readonly authorityRef: `sha256:${string}`;
  readonly effectiveFrom: string;
}

export interface MemoryDecisionPersona {
  readonly staticPrefix: string;
  readonly sha256: string;
}

export interface CreateMnemosyneDecisionRuntimeOptions {
  readonly dbPath: string;
  readonly backlogPath: string;
  /** Optional override; portable retention otherwise uses a separate sibling backlog. */
  readonly retentionBacklogPath?: string;
  readonly transcriptDbPath: string;
  readonly receipts: MemoryTurnReceiptStore;
  readonly transcriptStore: TranscriptStore;
  readonly mode: MemoryDecisionMode;
  readonly policyId: string;
  /**
   * Legacy keeps the historical generic D0 path. Portable-retention parks
   * generic receipts and admits long-term work only after Retention classifies it.
   */
  readonly ingressAuthority?: MemoryIngressAuthorityMode;
  /** Required in full mode; enqueue-only deliberately constructs no model. */
  readonly decisionProvider?: ModelProvider;
  /** Required in full mode; this is the dedicated memory-governance persona. */
  readonly decisionPersona?: MemoryDecisionPersona;
  /** Required in full mode; no durable owner policy means no auto activation. */
  readonly policy?: MemoryDecisionPolicy;
  readonly audit?: (event: Readonly<Record<string, unknown>>) => void;
  readonly loadPackage?: MnemosynePackageLoader;
  readonly now?: () => Date;
}

export interface RetentionClassifiedIngressResult {
  readonly destination: string;
  readonly reasonCode: string;
  readonly admitted: boolean;
}

export interface MnemosyneDecisionRuntime {
  /** Enqueue one already-delivered durable Delos turn from its generic receipt. */
  enqueueDeliveredTurn(turnId: string): Promise<boolean>;
  /**
   * Portable-retention seam. The request is validated/classified only by the
   * root @delos/mnemosyne Retention API; Delos never imports package internals.
   */
  admitRetentionClassifiedTurn(
    turnId: string,
    retentionRequest: unknown,
  ): Promise<RetentionClassifiedIngressResult>;
  /** Reconcile pre-provider receipts left pending by a crash/restart. */
  recoverPendingReceipts(): Promise<number>;
  status(): Readonly<Record<string, unknown>>;
  close(): Promise<void>;
}

interface FrozenTurnSnapshot {
  conversationId: string;
  turnId: string;
  userMessageId: string | null;
  userText: string | null;
  assistantText: string | null;
  variantSha256: string | null;
  selectedMemoryIds: string[];
}

interface MemoryStoreLike {
  listPriors(): Array<{ key: string; version: number }>;
  latestCardAnchor(id: string): { eventId: string; contentSha256: string } | null;
  historicalCardSha(id: string, eventId: string): string | null;
  priorVersionKnown(key: string, version: number): boolean;
}

interface MemoryLogLike {
  close(): void;
  backupTo(path: string): void;
}

interface MnemosyneHandleLike {
  readonly store: MemoryStoreLike;
  readonly log: MemoryLogLike;
}

interface GovernanceCardLike {
  readonly id: string;
  readonly lifecycle_state: string;
  readonly sensitivity: string;
}

interface GovernanceServiceLike {
  ensureOwnerPolicy(policy: unknown): Promise<{ status: string; detail?: string; issues?: unknown[] }>;
  ownerPolicy(policyId: string): { policyId: string; manualPerCardApprovalRequired: boolean } | null;
  getCard(id: string): GovernanceCardLike | undefined;
  findActiveBySourceTurn(turnId: string): { id: string } | undefined;
}

interface DecisionBacklogLike {
  enqueue(input: unknown): { identity: string; enqueued: boolean };
  close(): void;
  counters?(): Readonly<Record<string, unknown>>;
}

interface DecisionWorkerLike {
  tick(): Promise<void>;
  status(): Readonly<Record<string, unknown>>;
}

interface RetentionDecisionLike {
  readonly destination: string;
  readonly reasonCode: string;
  readonly longTermCandidateAdmissionAllowed: boolean;
  readonly governedCorrectionAdmissionAllowed: boolean;
  readonly writePerformed: false;
}

interface MnemosyneDecisionModule {
  readonly Governance: {
    readonly MnemosyneGovernanceService: new (options: {
      store: MemoryStoreLike;
      backup: (label: string) => { path: string };
      audit: (event: Record<string, unknown>) => void;
    }) => GovernanceServiceLike;
  };
  readonly CompanionSink: {
    readonly GovernedCompanionProposalSink: new (service: GovernanceServiceLike) => unknown;
  };
  readonly DecisionBacklog: {
    readonly DecisionBacklog: new (path: string) => DecisionBacklogLike;
  };
  readonly DecisionWorker: {
    readonly DecisionWorker: new (options: Record<string, unknown>) => DecisionWorkerLike;
    readonly defineOwnerAutoMemoryPolicy: (policy: MemoryDecisionPolicy & {
      authority: "owner_global_policy";
      manualPerCardApprovalRequired: false;
      ownerCanViewEditRevoke: true;
    }) => unknown;
  };
  readonly ProposalAutomation: {
    readonly turnContentHash: (userText: string | null, assistantText: string | null) => string;
  };
  readonly SqliteMnemosyne: {
    readonly openMnemosyne: (dbPath: string) => MnemosyneHandleLike;
  };
  readonly Retention?: {
    readonly dispatchPortableRetention: (request: unknown) => unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNamespace(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MnemosynePackageError(
      "package_incompatible",
      `The installed @delos/mnemosyne package does not expose the ${name} API required for memory decisions.`,
    );
  }
  return value;
}

function requireFn(container: Record<string, unknown>, key: string): Function {
  const value = container[key];
  if (typeof value !== "function") {
    throw new MnemosynePackageError(
      "package_incompatible",
      "The installed @delos/mnemosyne package does not expose the required memory-decision API.",
    );
  }
  return value;
}

function parseModule(value: unknown, requireRetention: boolean): MnemosyneDecisionModule {
  const root = requireNamespace(value, "root");
  const governance = requireNamespace(root["Governance"], "Governance");
  const companionSink = requireNamespace(root["CompanionSink"], "CompanionSink");
  const decisionBacklog = requireNamespace(root["DecisionBacklog"], "DecisionBacklog");
  const decisionWorker = requireNamespace(root["DecisionWorker"], "DecisionWorker");
  const proposalAutomation = requireNamespace(root["ProposalAutomation"], "ProposalAutomation");
  const sqlite = requireNamespace(root["SqliteMnemosyne"], "SqliteMnemosyne");
  const retention = requireRetention
    ? requireNamespace(root["Retention"], "Retention")
    : isRecord(root["Retention"])
      ? root["Retention"]
      : undefined;

  requireFn(governance, "MnemosyneGovernanceService");
  requireFn(companionSink, "GovernedCompanionProposalSink");
  requireFn(decisionBacklog, "DecisionBacklog");
  requireFn(decisionWorker, "DecisionWorker");
  requireFn(decisionWorker, "defineOwnerAutoMemoryPolicy");
  requireFn(proposalAutomation, "turnContentHash");
  requireFn(sqlite, "openMnemosyne");
  if (retention !== undefined) requireFn(retention, "dispatchPortableRetention");
  return value as MnemosyneDecisionModule;
}

function parseRetentionDecision(value: unknown): RetentionDecisionLike {
  if (!isRecord(value)) {
    throw new Error("Mnemosyne retention returned an invalid decision.");
  }
  const destination = value["destination"];
  const reasonCode = value["reasonCode"];
  const longTerm = value["longTermCandidateAdmissionAllowed"];
  const correction = value["governedCorrectionAdmissionAllowed"];
  if (
    typeof destination !== "string" ||
    typeof reasonCode !== "string" ||
    typeof longTerm !== "boolean" ||
    typeof correction !== "boolean" ||
    value["writePerformed"] !== false
  ) {
    throw new Error("Mnemosyne retention returned an invalid decision.");
  }
  return {
    destination,
    reasonCode,
    longTermCandidateAdmissionAllowed: longTerm,
    governedCorrectionAdmissionAllowed: correction,
    writePerformed: false,
  };
}

function readFrozenTurn(
  transcriptDbPath: string,
  receipt: MemoryTurnReceipt,
): FrozenTurnSnapshot | null {
  const db = new DatabaseSync(transcriptDbPath);
  try {
    const turn = db.prepare(
      "SELECT state, conversation_id FROM external_turns WHERE id=?",
    ).get(receipt.turnId) as { state: string; conversation_id: string } | undefined;
    if (turn === undefined || turn.state !== "delivered" || turn.conversation_id !== receipt.conversationId) {
      return null;
    }
    const rows = db.prepare(
      "SELECT id, role, text FROM messages WHERE external_turn_id=? ORDER BY ordinal",
    ).all(receipt.turnId) as Array<{ id: string; role: string; text: string }>;
    const user = rows.find((row) => row.role === "user");
    const assistant = rows.find((row) => row.role === "assistant");
    if (user === undefined || assistant === undefined) return null;
    return {
      conversationId: receipt.conversationId,
      turnId: receipt.turnId,
      userMessageId: user.id,
      userText: user.text,
      assistantText: assistant.text,
      variantSha256: receipt.variantSha256,
      selectedMemoryIds: [...receipt.selectedIds],
    };
  } finally {
    db.close();
  }
}

function decisionProviderAdapter(provider: ModelProvider): {
  generate(request: unknown): Promise<unknown>;
} {
  return {
    async generate(request: unknown): Promise<unknown> {
      if (!isRecord(request)) throw new Error("invalid memory-decision request");
      const conversationId = request["conversationId"];
      const turnId = request["turnId"];
      const systemPrompt = request["systemPrompt"];
      const dynamicPrompt = request["dynamicPrompt"];
      if (
        typeof conversationId !== "string" ||
        typeof turnId !== "string" ||
        typeof systemPrompt !== "string" ||
        typeof dynamicPrompt !== "string"
      ) {
        throw new Error("invalid memory-decision request");
      }
      return provider.generate({
        conversationId,
        turnId,
        systemPrompt,
        messages: [{ role: "user", text: dynamicPrompt }],
      });
    },
  };
}

/**
 * Host-side bridge for the public package's durable decision machinery.
 * Enqueue-only mode is provider-free. Full mode requires an explicitly chosen
 * separate decision provider, persona and durable owner policy.
 */
export async function createMnemosyneDecisionRuntime(
  options: CreateMnemosyneDecisionRuntimeOptions,
): Promise<MnemosyneDecisionRuntime> {
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? (() => undefined);
  const loader = options.loadPackage ?? defaultMnemosynePackageLoader;
  const ingressAuthority = resolveGenericMemoryIngressAuthority(
    options.ingressAuthority ?? process.env["DELOS_MEMORY_RETENTION"],
  );
  options.receipts.setDefaultIngressGeneration(ingressAuthority.receiptGeneration);

  if (options.policyId.trim().length === 0) {
    throw new Error("Memory decisions require a non-empty policy id.");
  }
  if (
    options.mode === "full" &&
    (options.decisionProvider === undefined ||
      options.decisionPersona === undefined ||
      options.policy === undefined)
  ) {
    throw new Error(
      "Full memory decisions require an explicit decision provider, decision persona, and owner policy.",
    );
  }

  let rawModule: unknown;
  try {
    rawModule = await loader(MNEMOSYNE_PACKAGE_NAME);
  } catch {
    throw new MnemosynePackageError(
      "package_unavailable",
      "Memory decisions are enabled, but @delos/mnemosyne is not installed.",
    );
  }
  const module = parseModule(rawModule, ingressAuthority.mode === "portable-retention");

  let handle: MnemosyneHandleLike;
  try {
    handle = module.SqliteMnemosyne.openMnemosyne(options.dbPath);
  } catch {
    throw new MnemosynePackageError(
      "database_unavailable",
      "Mnemosyne could not open the configured memory database for decisions.",
    );
  }

  const backup = (label: string): { path: string } => {
    const target = `${options.dbPath}.public-governance-${Date.now()}-${randomUUID().slice(0, 8)}-${label}`;
    handle.log.backupTo(target);
    return { path: target };
  };
  const service = new module.Governance.MnemosyneGovernanceService({
    store: handle.store,
    backup,
    audit: (event) => audit(event),
  });
  const sink = new module.CompanionSink.GovernedCompanionProposalSink(service);
  const backlogPath =
    ingressAuthority.mode === "portable-retention"
      ? options.retentionBacklogPath ?? `${options.backlogPath}.retention`
      : options.backlogPath;
  const backlog = new module.DecisionBacklog.DecisionBacklog(backlogPath);

  let worker: DecisionWorkerLike | null = null;
  if (options.mode === "full") {
    const policy = module.DecisionWorker.defineOwnerAutoMemoryPolicy({
      ...options.policy!,
      authority: "owner_global_policy",
      manualPerCardApprovalRequired: false,
      ownerCanViewEditRevoke: true,
    });
    const registration = await service.ensureOwnerPolicy(policy);
    if (registration.status === "refused") {
      backlog.close();
      handle.log.close();
      throw new Error("The configured owner memory policy was refused by Mnemosyne.");
    }

    const provider = decisionProviderAdapter(options.decisionProvider!);
    worker = new module.DecisionWorker.DecisionWorker({
      backlog,
      sink,
      provider,
      persona: options.decisionPersona!,
      snapshotByTurn: (turnId: string) => {
        const receipt = options.receipts.get(turnId);
        return receipt === null ? null : readFrozenTurn(options.transcriptDbPath, receipt);
      },
      frozenVerifier: {
        cardSha: (memoryId: string, eventId: string) =>
          handle.store.historicalCardSha(memoryId, eventId),
        priorKnown: (key: string, version: number) => handle.store.priorVersionKnown(key, version),
      },
      cardSensitivity: (memoryId: string) => service.getCard(memoryId)?.sensitivity ?? null,
      // Public v0.2 does not yet expose the richer served-card proof used by
      // the private house to authorize automatic supersession. Keep it off.
      cardActive: (_memoryId: string) => false,
      existingCardForTurn: (turnId: string) => service.findActiveBySourceTurn(turnId),
      policyId: options.policyId,
      policy: () => service.ownerPolicy(options.policyId),
      mode: "full",
      audit: (event: Record<string, unknown>) => audit(event),
      now,
    });
  }

  let pump: Promise<void> = Promise.resolve();
  let closed = false;
  function kickWorker(): void {
    if (worker === null || closed) return;
    pump = pump.then(async () => {
      // Drain a bounded batch. The worker itself owns hourly/daily budgets and
      // breaker state; repeated empty ticks are harmless and provider-free.
      for (let i = 0; i < 16; i += 1) await worker!.tick();
    }).catch(() => undefined);
  }

  async function enqueueReceipt(
    receipt: MemoryTurnReceipt,
    lane: "legacy_d0" | "retention_classified",
  ): Promise<boolean> {
    const snapshot = readFrozenTurn(options.transcriptDbPath, receipt);
    if (snapshot === null || snapshot.userText === null || snapshot.assistantText === null) {
      return false;
    }
    const selectedRefs = receipt.selectedIds.map((id) => {
      const anchor = handle.store.latestCardAnchor(id);
      return {
        id,
        anchor_event_id: anchor?.eventId ?? "unavailable",
        content_sha256: anchor?.contentSha256 ?? "unavailable",
      };
    });
    const contentSha256 = module.ProposalAutomation.turnContentHash(
      snapshot.userText,
      snapshot.assistantText,
    );
    const result = backlog.enqueue({
      conversationId: receipt.conversationId,
      turnId: receipt.turnId,
      userMessageId: snapshot.userMessageId,
      contentSha256,
      variantSha256: receipt.variantSha256,
      sceneMode: receipt.scene.mode,
      sceneAuId: receipt.scene.mode === "au" ? receipt.scene.auId : null,
      origin: "live",
      policyVersion: options.policyId,
      selectedRefs,
      priorVersions: receipt.priorVersions,
      sourceTime: receipt.sourceTime,
    });
    options.receipts.markEnqueued(receipt.turnId, now().toISOString());
    audit({
      type: "public_memory_decision_ingress",
      lane,
      outcome: result.enqueued ? "deferred" : "already_present",
      turn_id: receipt.turnId,
      identity: result.identity.slice(0, 16),
      scene: receipt.scene.mode,
      selected_count: receipt.selectedIds.length,
    });
    kickWorker();
    return true;
  }

  function parkGenericReceipt(receipt: MemoryTurnReceipt): boolean {
    audit({
      type: "public_memory_decision_ingress",
      lane: "generic_d0",
      outcome: "parked_evidence",
      turn_id: receipt.turnId,
      ingress_generation: receipt.ingressGeneration,
      scene: receipt.scene.mode,
      selected_count: receipt.selectedIds.length,
    });
    return true;
  }

  return {
    async enqueueDeliveredTurn(turnId: string): Promise<boolean> {
      if (closed) return false;
      const receipt = options.receipts.get(turnId);
      if (receipt === null) return false;
      if (!genericMemoryReceiptMayActivate(receipt.ingressGeneration, ingressAuthority)) {
        return parkGenericReceipt(receipt);
      }
      return enqueueReceipt(receipt, "legacy_d0");
    },
    async admitRetentionClassifiedTurn(
      turnId: string,
      retentionRequest: unknown,
    ): Promise<RetentionClassifiedIngressResult> {
      if (closed || ingressAuthority.mode !== "portable-retention") {
        return { destination: "quarantine", reasonCode: "retention_authority_off", admitted: false };
      }
      const receipt = options.receipts.get(turnId);
      if (
        receipt === null ||
        receipt.ingressGeneration !== MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION
      ) {
        return { destination: "quarantine", reasonCode: "receipt_not_retention_evidence", admitted: false };
      }
      const retention = module.Retention;
      if (retention === undefined) {
        throw new MnemosynePackageError(
          "package_incompatible",
          "Portable retention requires the @delos/mnemosyne Retention API.",
        );
      }
      const decision = parseRetentionDecision(retention.dispatchPortableRetention(retentionRequest));
      if (!decision.longTermCandidateAdmissionAllowed) {
        audit({
          type: "public_memory_retention_ingress",
          outcome: "parked_evidence",
          turn_id: receipt.turnId,
          destination: decision.destination,
          reason_code: decision.reasonCode,
          correction_lane: decision.governedCorrectionAdmissionAllowed,
        });
        return {
          destination: decision.destination,
          reasonCode: decision.reasonCode,
          admitted: false,
        };
      }
      const admitted = await enqueueReceipt(receipt, "retention_classified");
      return {
        destination: decision.destination,
        reasonCode: decision.reasonCode,
        admitted,
      };
    },
    async recoverPendingReceipts(): Promise<number> {
      if (closed) return 0;
      if (!ingressAuthority.autonomousActivationAllowed) {
        // Old legacy rows remain untouched; the separate retention backlog can
        // resume only work that previously crossed the classified admission seam.
        kickWorker();
        return 0;
      }
      let recovered = 0;
      for (const receipt of options.receipts.pending()) {
        if (!genericMemoryReceiptMayActivate(receipt.ingressGeneration, ingressAuthority)) continue;
        if (await enqueueReceipt(receipt, "legacy_d0")) recovered += 1;
      }
      return recovered;
    },
    status(): Readonly<Record<string, unknown>> {
      return {
        mode: options.mode,
        policyId: options.policyId,
        ingressAuthority: ingressAuthority.mode,
        pendingReceipts: ingressAuthority.autonomousActivationAllowed
          ? options.receipts.pending().length
          : 0,
        ...(worker === null ? {} : { worker: worker.status() }),
        ...(backlog.counters === undefined ? {} : { backlog: backlog.counters() }),
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pump;
      backlog.close();
      handle.log.close();
    },
  };
}
