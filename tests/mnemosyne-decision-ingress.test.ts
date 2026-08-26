import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { TranscriptStore } from "../core/ports/transcript-store.js";
import {
  MEMORY_INGRESS_LEGACY_GENERATION,
  MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
} from "../adapters/memory/memory-ingress-authority.js";
import { MemoryTurnReceiptStore } from "../adapters/memory/memory-turn-receipts.js";
import { createMnemosyneDecisionRuntime } from "../adapters/memory/mnemosyne-decision-runtime.js";

const NOW = new Date("2026-08-26T13:00:00.000Z");
const fakeTranscriptStore = {} as TranscriptStore;

function makeTranscript(path: string, turnId: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE external_turns (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        conversation_id TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        external_turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO external_turns (id, state, conversation_id) VALUES (?, 'delivered', ?)")
      .run(turnId, "conversation-synthetic");
    db.prepare(
      "INSERT INTO messages (id, external_turn_id, ordinal, role, text) VALUES (?, ?, ?, ?, ?)",
    ).run("user-synthetic", turnId, 1, "user", "Synthetic durable preference evidence.");
    db.prepare(
      "INSERT INTO messages (id, external_turn_id, ordinal, role, text) VALUES (?, ?, ?, ?, ?)",
    ).run("assistant-synthetic", turnId, 2, "assistant", "Synthetic acknowledgement.");
  } finally {
    db.close();
  }
}

function fakePackage(paths: string[], enqueued: unknown[]): unknown {
  class GovernanceService {
    constructor(_options: unknown) {}
    async ensureOwnerPolicy(): Promise<{ status: string }> { return { status: "ok" }; }
    ownerPolicy(): { policyId: string; manualPerCardApprovalRequired: false } {
      return { policyId: "policy-synthetic", manualPerCardApprovalRequired: false };
    }
    getCard(): undefined { return undefined; }
    findActiveBySourceTurn(): undefined { return undefined; }
  }
  class CompanionSink { constructor(_service: unknown) {} }
  class Backlog {
    constructor(path: string) { paths.push(path); }
    enqueue(input: unknown): { identity: string; enqueued: boolean } {
      enqueued.push(input);
      return { identity: `synthetic-${enqueued.length}`, enqueued: true };
    }
    close(): void {}
    counters(): Readonly<Record<string, unknown>> { return { deferred_total: enqueued.length }; }
  }
  class Worker {
    constructor(_options: unknown) {}
    async tick(): Promise<void> {}
    status(): Readonly<Record<string, unknown>> { return {}; }
  }
  return {
    Governance: { MnemosyneGovernanceService: GovernanceService },
    CompanionSink: { GovernedCompanionProposalSink: CompanionSink },
    DecisionBacklog: { DecisionBacklog: Backlog },
    DecisionWorker: {
      DecisionWorker: Worker,
      defineOwnerAutoMemoryPolicy: (policy: unknown) => policy,
    },
    ProposalAutomation: { turnContentHash: () => "b".repeat(64) },
    SqliteMnemosyne: {
      openMnemosyne: () => ({
        store: {
          listPriors: () => [],
          latestCardAnchor: () => null,
          historicalCardSha: () => null,
          priorVersionKnown: () => false,
        },
        log: { close: () => undefined, backupTo: (_path: string) => undefined },
      }),
    },
    Retention: {
      dispatchPortableRetention: (request: unknown) => {
        const record = request as { evidenceCodes?: unknown };
        const durable = Array.isArray(record.evidenceCodes) && record.evidenceCodes.includes("stable_preference");
        return durable
          ? {
              schemaVersion: 1,
              destination: "governed_long_term",
              reasonCode: "durable_candidate",
              longTermCandidateAdmissionAllowed: true,
              governedCorrectionAdmissionAllowed: false,
              writePerformed: false,
            }
          : {
              schemaVersion: 1,
              destination: "session_continuity",
              reasonCode: "volatile_session_only",
              longTermCandidateAdmissionAllowed: false,
              governedCorrectionAdmissionAllowed: false,
              writePerformed: false,
            };
      },
    },
  };
}

const receipt = {
  turnId: "turn-synthetic",
  conversationId: "conversation-synthetic",
  variantSha256: "a".repeat(64),
  scene: { mode: "ordinary" as const, intimacyActive: false },
  selectedIds: [] as const,
  priorVersions: {},
  sourceTime: NOW.toISOString(),
};

test("portable retention parks generic D0 and only classified durable evidence enters its separate backlog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delos-retention-ingress-"));
  const transcriptPath = join(dir, "transcript.db");
  const receipts = new MemoryTurnReceiptStore(join(dir, "receipts.db"));
  const paths: string[] = [];
  const enqueued: unknown[] = [];
  try {
    makeTranscript(transcriptPath, receipt.turnId);
    const runtime = await createMnemosyneDecisionRuntime({
      dbPath: join(dir, "memory.db"),
      backlogPath: join(dir, "legacy-backlog.db"),
      retentionBacklogPath: join(dir, "retention-backlog.db"),
      transcriptDbPath: transcriptPath,
      receipts,
      transcriptStore: fakeTranscriptStore,
      mode: "enqueue-only",
      policyId: "policy-synthetic",
      ingressAuthority: "portable-retention",
      loadPackage: async () => fakePackage(paths, enqueued),
      now: () => new Date(NOW),
    });

    receipts.record(receipt);
    assert.equal(
      receipts.get(receipt.turnId)?.ingressGeneration,
      MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
    );
    assert.equal(await runtime.enqueueDeliveredTurn(receipt.turnId), true);
    assert.equal(enqueued.length, 0, "generic D0 bypassed retention classification");
    assert.deepEqual(paths, [join(dir, "retention-backlog.db")]);

    const short = await runtime.admitRetentionClassifiedTurn(receipt.turnId, {
      schemaVersion: 1,
      evidenceCodes: ["session_only"],
      auId: null,
    });
    assert.deepEqual(short, {
      destination: "session_continuity",
      reasonCode: "volatile_session_only",
      admitted: false,
    });
    assert.equal(enqueued.length, 0);

    const durable = await runtime.admitRetentionClassifiedTurn(receipt.turnId, {
      schemaVersion: 1,
      evidenceCodes: ["stable_preference"],
      auId: null,
    });
    assert.deepEqual(durable, {
      destination: "governed_long_term",
      reasonCode: "durable_candidate",
      admitted: true,
    });
    assert.equal(enqueued.length, 1);
    assert.notEqual(receipts.get(receipt.turnId)?.enqueuedAt, null);
    await runtime.close();
  } finally {
    receipts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy fallback cannot resurrect a retention-era receipt, while legacy receipts retain compatibility", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delos-retention-fallback-"));
  const transcriptPath = join(dir, "transcript.db");
  const receipts = new MemoryTurnReceiptStore(join(dir, "receipts.db"));
  const paths: string[] = [];
  const enqueued: unknown[] = [];
  try {
    makeTranscript(transcriptPath, receipt.turnId);
    receipts.record({ ...receipt, ingressGeneration: MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION });
    const runtime = await createMnemosyneDecisionRuntime({
      dbPath: join(dir, "memory.db"),
      backlogPath: join(dir, "legacy-backlog.db"),
      transcriptDbPath: transcriptPath,
      receipts,
      transcriptStore: fakeTranscriptStore,
      mode: "enqueue-only",
      policyId: "policy-synthetic",
      ingressAuthority: "legacy",
      loadPackage: async () => fakePackage(paths, enqueued),
      now: () => new Date(NOW),
    });
    assert.equal(await runtime.enqueueDeliveredTurn(receipt.turnId), true);
    assert.equal(enqueued.length, 0, "legacy fallback resurrected retention-era evidence");
    await runtime.close();

    const legacyReceipts = new MemoryTurnReceiptStore(":memory:");
    try {
      legacyReceipts.record({ ...receipt, ingressGeneration: MEMORY_INGRESS_LEGACY_GENERATION });
      assert.equal(legacyReceipts.pending().length, 1);
    } finally {
      legacyReceipts.close();
    }
  } finally {
    receipts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
