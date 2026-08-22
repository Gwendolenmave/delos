/**
 * SQLite transcript store, on node:sqlite.
 *
 * DEPENDENCY DECISION, recorded as the programme requires: `node:sqlite`
 * (the built-in DatabaseSync) rather than better-sqlite3. The built-in needs
 * no native compilation and adds nothing to the supply chain; its synchronous
 * API is exactly right for a local single-user store; and the subset used
 * here (exec, prepare, transactions via BEGIN/COMMIT) is stable in practice.
 * Rejected alternative: better-sqlite3 - functionally equivalent and mature,
 * but a native module with a build step and a second copy of SQLite.
 * Honest caveat: node:sqlite is flagged experimental in Node 22.x; the port
 * boundary means swapping implementations later touches one file.
 *
 * MIGRATIONS are versioned and atomic: each migration runs inside one
 * transaction together with the write that bumps `schema_version`, so a
 * failed migration leaves the database at the previous version with no
 * partial DDL applied. `:memory:` gives the optional non-persistent session.
 */

import { DatabaseSync } from "node:sqlite";

import type { ContainmentRecord } from "../../core/services/output-containment.js";
import {
  assertTransition,
  TranscriptStoreError,
  TURN_STATES,
  type AppendMessageInput,
  type ConversationRecord,
  type CreateConversationInput,
  type EvidenceSource,
  type ExternalTurnRecord,
  type MessageRecord,
  type ProviderObservation,
  type TranscriptStore,
  type TurnState,
} from "../../core/ports/transcript-store.js";

export interface SqliteStoreOptions {
  /** Absolute database path, or ":memory:" for a non-persistent session. */
  readonly path: string;
  readonly newId: (prefix: string) => string;
}

export interface Migration {
  readonly version: number;
  readonly up: string;
}

/** Append-only. Never edit a shipped migration; add the next version. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        manual_enabled TEXT NOT NULL DEFAULT '[]',
        manual_disabled TEXT NOT NULL DEFAULT '[]',
        surface TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        state TEXT NOT NULL,
        external_turn_id TEXT,
        containment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, ordinal)
      );
      CREATE TABLE external_turns (
        id TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        external_conversation_key TEXT NOT NULL,
        external_turn_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        assistant_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (surface, external_conversation_key, external_turn_key)
      );
      CREATE TABLE provider_observations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        configured_model TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        served_model TEXT,
        protocol TEXT NOT NULL,
        capability TEXT,
        evidence_source TEXT NOT NULL,
        at_iso TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, ordinal);
      CREATE INDEX idx_observations_profile ON provider_observations(profile_id, at_iso);
    `,
  },
];

function corrupt(error: unknown): TranscriptStoreError {
  // The underlying error text can name paths; keep the surfaced message safe.
  return new TranscriptStoreError(
    "corrupt",
    "The transcript database could not be read or written. It may be " +
      "corrupt; restore from a backup or move it aside to start fresh.",
    // cause retained for developer diagnostics, never printed by surfaces:
  );
}

/** Exposed for tests: apply migrations atomically, rolling back on failure. */
export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
): number {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
  );
  const row = database.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  let version = row?.version ?? 0;
  if (row === undefined) {
    database.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  }

  for (const migration of migrations) {
    if (migration.version <= version) continue;
    database.exec("BEGIN");
    try {
      database.exec(migration.up);
      database.prepare("UPDATE schema_version SET version = ?").run(migration.version);
      database.exec("COMMIT");
      version = migration.version;
    } catch {
      database.exec("ROLLBACK");
      throw new TranscriptStoreError(
        "migration_failed",
        "Database migration to version " + String(migration.version) +
          " failed and was rolled back; the database remains at version " +
          String(version) + ".",
      );
    }
  }
  return version;
}

export function createSqliteTranscriptStore(options: SqliteStoreOptions): TranscriptStore {
  const { newId } = options;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
  } catch (error) {
    throw corrupt(error);
  }

  runMigrations(db, MIGRATIONS);

  function nowPair(nowIso: string): { created_at: string; updated_at: string } {
    return { created_at: nowIso, updated_at: nowIso };
  }

  function rowToConversation(row: Record<string, unknown>): ConversationRecord {
    return {
      id: String(row["id"]),
      title: String(row["title"]),
      personaId: String(row["persona_id"]),
      providerProfileId: String(row["provider_profile_id"]),
      manualEnabled: JSON.parse(String(row["manual_enabled"])) as string[],
      manualDisabled: JSON.parse(String(row["manual_disabled"])) as string[],
      surface: String(row["surface"]),
      archived: row["archived"] === 1,
      createdAtIso: String(row["created_at"]),
      updatedAtIso: String(row["updated_at"]),
    };
  }

  function rowToMessage(row: Record<string, unknown>): MessageRecord {
    const containment = row["containment"];
    return {
      id: String(row["id"]),
      conversationId: String(row["conversation_id"]),
      role: row["role"] as "user" | "assistant",
      text: String(row["text"]),
      ordinal: Number(row["ordinal"]),
      state: row["state"] as TurnState,
      createdAtIso: String(row["created_at"]),
      updatedAtIso: String(row["updated_at"]),
      ...(row["external_turn_id"] == null ? {} : { externalTurnId: String(row["external_turn_id"]) }),
      ...(containment == null
        ? {}
        : { containment: JSON.parse(String(containment)) as ContainmentRecord[] }),
    };
  }

  function rowToTurn(row: Record<string, unknown>): ExternalTurnRecord {
    return {
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
    };
  }

  function rowToObservation(row: Record<string, unknown>): ProviderObservation {
    return {
      id: String(row["id"]),
      profileId: String(row["profile_id"]),
      configuredModel: String(row["configured_model"]),
      requestedModel: String(row["requested_model"]),
      ...(row["served_model"] == null ? {} : { servedModel: String(row["served_model"]) }),
      protocol: String(row["protocol"]),
      ...(row["capability"] == null ? {} : { capability: String(row["capability"]) }),
      evidenceSource: row["evidence_source"] as EvidenceSource,
      atIso: String(row["at_iso"]),
    };
  }

  function mustConversation(id: string): Record<string, unknown> {
    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new TranscriptStoreError("not_found", `No conversation ${id}.`);
    return row;
  }

  return {
    async createConversation(input: CreateConversationInput, nowIso: string) {
      if (input.title.trim().length === 0) {
        throw new TranscriptStoreError("invalid", "A conversation needs a title.");
      }
      const id = newId("conv");
      const t = nowPair(nowIso);
      db.prepare(
        `INSERT INTO conversations
           (id, title, persona_id, provider_profile_id, surface, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.title, input.personaId, input.providerProfileId, input.surface, t.created_at, t.updated_at);
      return rowToConversation(mustConversation(id));
    },

    async getConversation(id: string) {
      return rowToConversation(mustConversation(id));
    },

    async listConversations(includeArchived = false) {
      const rows = db
        .prepare(
          includeArchived
            ? "SELECT * FROM conversations ORDER BY updated_at DESC"
            : "SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC",
        )
        .all() as Record<string, unknown>[];
      return rows.map(rowToConversation);
    },

    async renameConversation(id: string, title: string, nowIso: string) {
      if (title.trim().length === 0) {
        throw new TranscriptStoreError("invalid", "A conversation needs a title.");
      }
      mustConversation(id);
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, nowIso, id);
    },

    async setConversationVariants(id, manualEnabled, manualDisabled, nowIso) {
      mustConversation(id);
      db.prepare(
        "UPDATE conversations SET manual_enabled = ?, manual_disabled = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(manualEnabled), JSON.stringify(manualDisabled), nowIso, id);
    },

    async archiveConversation(id: string, archived: boolean, nowIso: string) {
      mustConversation(id);
      db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, nowIso, id);
    },

    async deleteConversation(id: string) {
      mustConversation(id);
      // ON DELETE CASCADE removes messages and external turns atomically.
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    },

    async exportConversation(id: string) {
      const conversation = rowToConversation(mustConversation(id));
      const messages = (
        db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal").all(id) as Record<string, unknown>[]
      ).map(rowToMessage);
      return JSON.stringify({ schemaVersion: 1, conversation, messages }, null, 2);
    },

    async exportEverything() {
      const conversations = (
        db.prepare("SELECT * FROM conversations ORDER BY id").all() as Record<string, unknown>[]
      ).map(rowToConversation);
      const messages = (
        db.prepare("SELECT * FROM messages ORDER BY conversation_id, ordinal").all() as Record<string, unknown>[]
      ).map(rowToMessage);
      const externalTurns = (
        db.prepare("SELECT * FROM external_turns ORDER BY id").all() as Record<string, unknown>[]
      ).map(rowToTurn);
      const observations = (
        db.prepare("SELECT * FROM provider_observations ORDER BY id").all() as Record<string, unknown>[]
      ).map(rowToObservation);
      return JSON.stringify(
        { schemaVersion: 1, conversations, messages, externalTurns, observations },
        null,
        2,
      );
    },

    async importEverything(snapshot: string, policy: "replace" | "merge-skip") {
      let parsed: {
        schemaVersion?: unknown;
        conversations?: unknown;
        messages?: unknown;
        externalTurns?: unknown;
        observations?: unknown;
      };
      try {
        parsed = JSON.parse(snapshot) as typeof parsed;
      } catch {
        throw new TranscriptStoreError("invalid", "The transcript snapshot is not valid JSON.");
      }
      if (parsed.schemaVersion !== 1) {
        throw new TranscriptStoreError(
          "invalid",
          `Unsupported transcript snapshot schemaVersion ${String(parsed.schemaVersion)}.`,
        );
      }
      const conversations = (parsed.conversations ?? []) as ConversationRecord[];
      const messages = (parsed.messages ?? []) as MessageRecord[];
      const externalTurns = (parsed.externalTurns ?? []) as ExternalTurnRecord[];
      const observations = (parsed.observations ?? []) as ProviderObservation[];
      for (const [label, rows] of [
        ["conversations", conversations],
        ["messages", messages],
        ["externalTurns", externalTurns],
        ["observations", observations],
      ] as const) {
        if (!Array.isArray(rows)) {
          throw new TranscriptStoreError("invalid", `The snapshot's ${label} is not an array.`);
        }
        const ids = new Set<string>();
        for (const row of rows) {
          const id = (row as { id?: unknown }).id;
          if (typeof id !== "string" || id.length === 0) {
            throw new TranscriptStoreError("invalid", `A ${label} row has no id.`);
          }
          if (ids.has(id)) {
            throw new TranscriptStoreError("invalid", `Duplicate ${label} id in the snapshot: ${id}.`);
          }
          ids.add(id);
        }
      }
      const conversationIds = new Set(conversations.map((c) => c.id));
      for (const message of messages) {
        if (!conversationIds.has(message.conversationId)) {
          throw new TranscriptStoreError(
            "invalid",
            `Message ${message.id} references a conversation the snapshot does not contain.`,
          );
        }
        if (!TURN_STATES.includes(message.state)) {
          throw new TranscriptStoreError("invalid", `Message ${message.id} has unknown state.`);
        }
      }
      for (const turn of externalTurns) {
        if (!conversationIds.has(turn.conversationId)) {
          throw new TranscriptStoreError(
            "invalid",
            `External turn ${turn.id} references a conversation the snapshot does not contain.`,
          );
        }
      }

      // One transaction: either the whole snapshot lands, or none of it.
      const counts = { conversations: 0, messages: 0, externalTurns: 0, observations: 0 };
      db.exec("BEGIN IMMEDIATE");
      try {
        if (policy === "replace") {
          db.exec("DELETE FROM provider_observations");
          db.exec("DELETE FROM external_turns");
          db.exec("DELETE FROM messages");
          db.exec("DELETE FROM conversations");
        }
        const existing = (table: string, id: string): boolean =>
          policy === "merge-skip" &&
          db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

        for (const c of conversations) {
          if (existing("conversations", c.id)) continue;
          db.prepare(
            `INSERT INTO conversations
               (id, title, persona_id, provider_profile_id, manual_enabled, manual_disabled,
                surface, archived, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            c.id,
            c.title,
            c.personaId,
            c.providerProfileId,
            JSON.stringify(c.manualEnabled ?? []),
            JSON.stringify(c.manualDisabled ?? []),
            c.surface,
            c.archived ? 1 : 0,
            c.createdAtIso,
            c.updatedAtIso,
          );
          counts.conversations++;
        }
        for (const m of messages) {
          if (existing("messages", m.id)) continue;
          db.prepare(
            `INSERT INTO messages
               (id, conversation_id, role, text, ordinal, state, external_turn_id, containment,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            m.id,
            m.conversationId,
            m.role,
            m.text,
            m.ordinal,
            m.state,
            m.externalTurnId ?? null,
            m.containment === undefined ? null : JSON.stringify(m.containment),
            m.createdAtIso,
            m.updatedAtIso,
          );
          counts.messages++;
        }
        for (const t of externalTurns) {
          if (existing("external_turns", t.id)) continue;
          db.prepare(
            `INSERT INTO external_turns
               (id, surface, external_conversation_key, external_turn_key, conversation_id,
                state, assistant_message_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            t.id,
            t.surface,
            t.externalConversationKey,
            t.externalTurnKey,
            t.conversationId,
            t.state,
            t.assistantMessageId ?? null,
            t.createdAtIso,
            t.updatedAtIso,
          );
          counts.externalTurns++;
        }
        for (const o of observations) {
          if (existing("provider_observations", o.id)) continue;
          db.prepare(
            `INSERT INTO provider_observations
               (id, profile_id, configured_model, requested_model, served_model, protocol,
                capability, evidence_source, at_iso)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            o.id,
            o.profileId,
            o.configuredModel,
            o.requestedModel,
            o.servedModel ?? null,
            o.protocol,
            o.capability ?? null,
            o.evidenceSource,
            o.atIso,
          );
          counts.observations++;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (error instanceof TranscriptStoreError) throw error;
        throw new TranscriptStoreError(
          "invalid",
          "The snapshot could not be applied; the store was rolled back unchanged.",
        );
      }
      return counts;
    },

    async appendMessage(input: AppendMessageInput, nowIso: string) {
      mustConversation(input.conversationId);
      if (!TURN_STATES.includes(input.state)) {
        throw new TranscriptStoreError("invalid", `Unknown turn state ${input.state}.`);
      }
      const id = newId("msg");
      const t = nowPair(nowIso);
      // Ordinal assignment and insert in one transaction: stable ordering
      // under concurrent surface access, per conversation.
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM messages WHERE conversation_id = ?")
          .get(input.conversationId) as { next: number };
        db.prepare(
          `INSERT INTO messages
             (id, conversation_id, role, text, ordinal, state, external_turn_id, containment, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.role,
          input.text,
          row.next,
          input.state,
          input.externalTurnId ?? null,
          input.containment === undefined ? null : JSON.stringify(input.containment),
          t.created_at,
          t.updated_at,
        );
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(nowIso, input.conversationId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error instanceof TranscriptStoreError ? error : corrupt(error);
      }
      const inserted = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown>;
      return rowToMessage(inserted);
    },

    async setMessageState(id: string, state: TurnState, nowIso: string) {
      const row = db.prepare("SELECT state FROM messages WHERE id = ?").get(id) as
        | { state: TurnState }
        | undefined;
      if (row === undefined) throw new TranscriptStoreError("not_found", `No message ${id}.`);
      assertTransition(row.state, state);
      db.prepare("UPDATE messages SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso, id);
    },

    async setMessageText(id: string, text: string, nowIso: string) {
      const row = db.prepare("SELECT id FROM messages WHERE id = ?").get(id);
      if (row === undefined) throw new TranscriptStoreError("not_found", `No message ${id}.`);
      db.prepare("UPDATE messages SET text = ?, updated_at = ? WHERE id = ?").run(text, nowIso, id);
    },

    async listMessages(conversationId: string) {
      mustConversation(conversationId);
      const rows = db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY ordinal")
        .all(conversationId) as Record<string, unknown>[];
      return rows.map(rowToMessage);
    },

    async beginExternalTurn(surface, externalConversationKey, externalTurnKey, conversationId, nowIso) {
      mustConversation(conversationId);
      const t = nowPair(nowIso);
      const id = newId("xturn");
      // INSERT OR IGNORE + SELECT: concurrent duplicates converge on one row,
      // decided by the database's own uniqueness, not by application locks.
      db.prepare(
        `INSERT OR IGNORE INTO external_turns
           (id, surface, external_conversation_key, external_turn_key, conversation_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
      ).run(id, surface, externalConversationKey, externalTurnKey, conversationId, t.created_at, t.updated_at);
      const row = db
        .prepare(
          `SELECT * FROM external_turns
           WHERE surface = ? AND external_conversation_key = ? AND external_turn_key = ?`,
        )
        .get(surface, externalConversationKey, externalTurnKey) as Record<string, unknown>;
      const record = rowToTurn(row);
      return { record, existed: record.id !== id };
    },

    async getExternalTurn(id: string) {
      const row = db.prepare("SELECT * FROM external_turns WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new TranscriptStoreError("not_found", `No external turn ${id}.`);
      return rowToTurn(row);
    },

    async setExternalTurnState(id, state, nowIso, assistantMessageId) {
      const row = db.prepare("SELECT state FROM external_turns WHERE id = ?").get(id) as
        | { state: TurnState }
        | undefined;
      if (row === undefined) throw new TranscriptStoreError("not_found", `No external turn ${id}.`);
      assertTransition(row.state, state);
      if (assistantMessageId === undefined) {
        db.prepare("UPDATE external_turns SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso, id);
      } else {
        db.prepare(
          "UPDATE external_turns SET state = ?, assistant_message_id = ?, updated_at = ? WHERE id = ?",
        ).run(state, assistantMessageId, nowIso, id);
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
      return rows.map(rowToTurn);
    },

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
          detail: ok ? "quick_check ok" : "quick_check reported problems",
        };
      } catch {
        return { ok: false, schemaVersion: 0, detail: "The integrity probe itself failed." };
      }
    },

    async recordObservation(observation) {
      const id = newId("obs");
      db.prepare(
        `INSERT INTO provider_observations
           (id, profile_id, configured_model, requested_model, served_model, protocol, capability, evidence_source, at_iso)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        observation.profileId,
        observation.configuredModel,
        observation.requestedModel,
        observation.servedModel ?? null,
        observation.protocol,
        observation.capability ?? null,
        observation.evidenceSource satisfies EvidenceSource,
        observation.atIso,
      );
      return { id, ...observation };
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
      })) as ProviderObservation[];
    },

    async close() {
      db.close();
    },
  };
}
