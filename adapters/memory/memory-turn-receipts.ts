import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { MemorySceneIntent } from "../../core/ports/memory-context.js";

export interface MemoryTurnReceipt {
  readonly turnId: string;
  readonly conversationId: string;
  readonly variantSha256: string;
  readonly scene: MemorySceneIntent;
  readonly selectedIds: readonly string[];
  readonly priorVersions: Readonly<Record<string, number>>;
  readonly sourceTime: string;
  readonly enqueuedAt: string | null;
}

function sceneColumns(scene: MemorySceneIntent): { mode: string; auId: string | null; intimacy: number } {
  return {
    mode: scene.mode,
    auId: scene.mode === "au" ? scene.auId : null,
    intimacy: scene.intimacyActive ? 1 : 0,
  };
}

function parseScene(mode: string, auId: string | null, intimacy: number): MemorySceneIntent {
  const intimacyActive = intimacy === 1;
  if (mode === "au" && auId !== null && auId.length > 0) {
    return { mode: "au", auId, intimacyActive };
  }
  if (mode === "unknown") return { mode: "unknown", intimacyActive };
  return { mode: "ordinary", intimacyActive };
}

/**
 * Metadata-only crash bridge between provider-request assembly and the
 * asynchronous memory-decision lane. Raw dialogue and memory bodies never enter
 * this database; they remain authoritative in the transcript/Mnemosyne stores.
 */
export class MemoryTurnReceiptStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_turn_receipts (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        variant_sha256 TEXT NOT NULL,
        scene_mode TEXT NOT NULL CHECK(scene_mode IN ('ordinary','au','unknown')),
        scene_au_id TEXT,
        intimacy_active INTEGER NOT NULL CHECK(intimacy_active IN (0,1)),
        selected_ids TEXT NOT NULL,
        prior_versions TEXT NOT NULL,
        source_time TEXT NOT NULL,
        enqueued_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_turn_receipts_pending
        ON memory_turn_receipts(enqueued_at, source_time);
    `);
  }

  record(input: Omit<MemoryTurnReceipt, "enqueuedAt">): void {
    const scene = sceneColumns(input.scene);
    this.db.prepare(`
      INSERT INTO memory_turn_receipts (
        turn_id, conversation_id, variant_sha256, scene_mode, scene_au_id,
        intimacy_active, selected_ids, prior_versions, source_time, enqueued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(turn_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        variant_sha256=excluded.variant_sha256,
        scene_mode=excluded.scene_mode,
        scene_au_id=excluded.scene_au_id,
        intimacy_active=excluded.intimacy_active,
        selected_ids=excluded.selected_ids,
        prior_versions=excluded.prior_versions,
        source_time=excluded.source_time
    `).run(
      input.turnId,
      input.conversationId,
      input.variantSha256,
      scene.mode,
      scene.auId,
      scene.intimacy,
      JSON.stringify(input.selectedIds),
      JSON.stringify(input.priorVersions),
      input.sourceTime,
    );
  }

  get(turnId: string): MemoryTurnReceipt | null {
    const row = this.db.prepare("SELECT * FROM memory_turn_receipts WHERE turn_id=?").get(turnId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : this.row(row);
  }

  pending(): MemoryTurnReceipt[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_turn_receipts WHERE enqueued_at IS NULL ORDER BY source_time, turn_id",
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.row(row));
  }

  markEnqueued(turnId: string, atIso: string): void {
    this.db.prepare(
      "UPDATE memory_turn_receipts SET enqueued_at=COALESCE(enqueued_at, ?) WHERE turn_id=?",
    ).run(atIso, turnId);
  }

  close(): void {
    this.db.close();
  }

  private row(row: Record<string, unknown>): MemoryTurnReceipt {
    const selected = JSON.parse(String(row["selected_ids"] ?? "[]")) as unknown;
    const priors = JSON.parse(String(row["prior_versions"] ?? "{}")) as unknown;
    return {
      turnId: String(row["turn_id"]),
      conversationId: String(row["conversation_id"]),
      variantSha256: String(row["variant_sha256"]),
      scene: parseScene(
        String(row["scene_mode"]),
        row["scene_au_id"] === null ? null : String(row["scene_au_id"]),
        Number(row["intimacy_active"]),
      ),
      selectedIds: Array.isArray(selected)
        ? selected.filter((id): id is string => typeof id === "string")
        : [],
      priorVersions:
        typeof priors === "object" && priors !== null && !Array.isArray(priors)
          ? Object.fromEntries(
              Object.entries(priors as Record<string, unknown>).filter(
                (entry): entry is [string, number] =>
                  typeof entry[1] === "number" && Number.isInteger(entry[1]),
              ),
            )
          : {},
      sourceTime: String(row["source_time"]),
      enqueuedAt: row["enqueued_at"] === null ? null : String(row["enqueued_at"]),
    };
  }
}
