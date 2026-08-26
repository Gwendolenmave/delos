import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  genericMemoryReceiptMayActivate,
  MEMORY_INGRESS_LEGACY_GENERATION,
  MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
  resolveGenericMemoryIngressAuthority,
} from "../adapters/memory/memory-ingress-authority.js";
import { MemoryTurnReceiptStore } from "../adapters/memory/memory-turn-receipts.js";

const RECEIPT = {
  turnId: "turn-synthetic",
  conversationId: "conversation-synthetic",
  variantSha256: "a".repeat(64),
  scene: { mode: "ordinary" as const, intimacyActive: false },
  selectedIds: [] as const,
  priorVersions: {},
  sourceTime: "2026-08-26T12:00:00.000Z",
};

test("generic ingress keeps legacy compatibility and fails closed for retention/non-off modes", () => {
  const legacy = resolveGenericMemoryIngressAuthority("off");
  assert.deepEqual(legacy, {
    mode: "legacy",
    receiptGeneration: MEMORY_INGRESS_LEGACY_GENERATION,
    autonomousActivationAllowed: true,
  });
  assert.equal(genericMemoryReceiptMayActivate(MEMORY_INGRESS_LEGACY_GENERATION, legacy), true);
  assert.equal(
    genericMemoryReceiptMayActivate(MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION, legacy),
    false,
  );

  for (const raw of ["portable-retention", "future-non-off-mode"]) {
    const retention = resolveGenericMemoryIngressAuthority(raw);
    assert.deepEqual(retention, {
      mode: "portable-retention",
      receiptGeneration: MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
      autonomousActivationAllowed: false,
    });
    assert.equal(genericMemoryReceiptMayActivate(MEMORY_INGRESS_LEGACY_GENERATION, retention), false);
    assert.equal(
      genericMemoryReceiptMayActivate(MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION, retention),
      false,
    );
  }
});

test("retention-era generic receipts stay durably parked across reopen and legacy fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "delos-public-ingress-"));
  const path = join(dir, "receipts.db");
  try {
    const first = new MemoryTurnReceiptStore(path);
    first.setDefaultIngressGeneration(MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION);
    first.record(RECEIPT);
    assert.equal(
      first.get(RECEIPT.turnId)?.ingressGeneration,
      MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION,
    );
    assert.equal(first.pending().length, 0);
    first.close();

    const reopened = new MemoryTurnReceiptStore(path);
    const receipt = reopened.get(RECEIPT.turnId);
    assert.equal(receipt?.ingressGeneration, MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION);
    assert.equal(reopened.pending().length, 0);
    assert.equal(
      receipt === null
        ? true
        : genericMemoryReceiptMayActivate(
            receipt.ingressGeneration,
            resolveGenericMemoryIngressAuthority("off"),
          ),
      false,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy receipts remain pending and an existing turn cannot be relabelled by later config", () => {
  const store = new MemoryTurnReceiptStore(":memory:");
  try {
    store.record(RECEIPT);
    assert.equal(store.pending().length, 1);
    assert.equal(store.get(RECEIPT.turnId)?.ingressGeneration, MEMORY_INGRESS_LEGACY_GENERATION);

    store.setDefaultIngressGeneration(MEMORY_INGRESS_RETENTION_EVIDENCE_GENERATION);
    store.record({ ...RECEIPT, sourceTime: "2026-08-26T12:01:00.000Z" });
    assert.equal(store.get(RECEIPT.turnId)?.ingressGeneration, MEMORY_INGRESS_LEGACY_GENERATION);
    assert.equal(store.pending().length, 1);
  } finally {
    store.close();
  }
});
