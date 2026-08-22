/**
 * Phase 6 backup and restore: deterministic archives, paranoid inspection,
 * atomic application, honest credential state. Everything here runs against
 * in-memory stores and temp directories; no secret value ever exists in any
 * input, so none can leak into any output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BackupError,
  createBackupZip,
  inspectBackupZip,
  type BackupPieces,
} from "../adapters/backup/backup-archive.js";
import { applyBackup, previewBackup } from "../adapters/backup/restore.js";
import { writePackZip } from "../adapters/persona/pack-archive.js";
import { createSqliteTranscriptStore } from "../adapters/transcripts/sqlite-transcript-store.js";
import { createInMemorySituationStore } from "../core/services/current-situation.js";
import type { SecretStore } from "../core/ports/secret-store.js";
import type { TranscriptStore } from "../core/ports/transcript-store.js";

const T0 = "2026-08-02T10:00:00.000Z";

function newStore(tag = ""): TranscriptStore {
  let n = 0;
  // Distinct id spaces per store: a restore TARGET's own rows must not
  // collide with the snapshot's ids by counter coincidence.
  return createSqliteTranscriptStore({ path: ":memory:", newId: (p) => `${p}${tag}-${++n}` });
}

async function populatedStore(): Promise<TranscriptStore> {
  const store = newStore();
  const conversation = await store.createConversation(
    { title: "Backed up", personaId: "arti", providerProfileId: "local", surface: "web" }, // scan-allow-persona
    T0,
  );
  await store.appendMessage(
    { conversationId: conversation.id, role: "user", text: "Hello.", state: "delivered" },
    T0,
  );
  await store.appendMessage(
    { conversationId: conversation.id, role: "assistant", text: "Hi.", state: "delivered" },
    T0,
  );
  await store.beginExternalTurn("web", "tab-1", "turn-1", conversation.id, T0);
  await store.recordObservation({
    profileId: "local",
    configuredModel: "m",
    requestedModel: "m",
    servedModel: "served-m",
    protocol: "openai-chat-completions",
    evidenceSource: "provider-metadata",
    atIso: T0,
  });
  return store;
}

const PROVIDERS_DOC = JSON.stringify(
  {
    schemaVersion: 1,
    profiles: [
      {
        schemaVersion: 1,
        id: "local",
        kind: "openai-compatible",
        model: "m",
        baseUrl: "http://127.0.0.1:1/v1",
        auth: { source: "environment", transport: "bearer", secretId: "provider:local", envVar: "LOCAL_KEY" },
      },
    ],
  },
  null,
  2,
);

const TELEGRAM_DOC = JSON.stringify(
  { schemaVersion: 1, enabled: false, tokenSecretId: "telegram:bot", tokenEnvVar: "DELOS_TELEGRAM_BOT_TOKEN", allowedUserIds: [], defaultProviderProfileId: "", defaultPersonaId: "", defaultVariants: [] },
  null,
  2,
);

async function piecesFrom(store: TranscriptStore, situationsJson?: string): Promise<BackupPieces> {
  return {
    transcripts: await store.exportEverything(),
    situations: situationsJson ?? JSON.stringify({ schemaVersion: 1, situations: [] }, null, 2),
    providers: PROVIDERS_DOC,
    telegram: TELEGRAM_DOC,
    personaFiles: new Map([
      ["personas/mine/persona.json", JSON.stringify({ schemaVersion: 1, id: "mine", displayName: "Mine", base: ["base.md"] })],
      ["personas/mine/base.md", "You are mine."],
    ]),
    appVersion: "0.1.0-dev",
    transcriptSchemaVersion: 1,
  };
}

const emptySecrets: SecretStore = {
  name: "empty",
  writable: false,
  has: async () => false,
  get: async () => ({ found: false, reason: "not_configured", detail: "nothing here" }),
};

let situationSeq = 0;

async function freshDeps() {
  const dataDir = await mkdtemp(join(tmpdir(), "delos-restore-"));
  const personaDir = join(dataDir, "personas");
  await mkdir(personaDir, { recursive: true });
  return {
    deps: {
      store: newStore("-target"),
      situations: createInMemorySituationStore(() => `sit-${++situationSeq}`),
      secretStore: emptySecrets,
      dataDir,
      personaDir,
    },
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test("backup: the same state produces byte-identical archives", async () => {
  const store = await populatedStore();
  const a = createBackupZip(await piecesFrom(store));
  const b = createBackupZip(await piecesFrom(store));
  assert.ok(a.equals(b), "two backups of one state differ - determinism lost");

  await store.appendMessage(
    {
      conversationId: (await store.listConversations(true))[0]!.id,
      role: "user",
      text: "One more.",
      state: "delivered",
    },
    T0,
  );
  const c = createBackupZip(await piecesFrom(store));
  assert.ok(!a.equals(c), "a changed state produced the same bytes");
});

test("backup: inspection previews honest counts and carries no secret anywhere", async () => {
  const store = await populatedStore();
  const zip = createBackupZip(await piecesFrom(store));
  const preview = previewBackup(zip);
  assert.equal(preview.counts.conversations, 1);
  assert.equal(preview.counts.messages, 2);
  assert.equal(preview.counts.externalTurns, 1);
  assert.equal(preview.counts.observations, 1);
  assert.equal(preview.counts.providerProfiles, 1);
  assert.equal(preview.counts.personaPacks, 1);

  const text = zip.toString("latin1");
  assert.ok(!text.includes("sk-"), "a key shape appears in the archive");
  assert.ok(text.includes("provider:local"), "the profile reference should be present");
  assert.ok(text.includes("LOCAL_KEY"), "the env var NAME is non-secret and should be present");
});

test("restore: a fresh machine gets the full state back, credentials honestly missing", async () => {
  const source = await populatedStore();
  const zip = createBackupZip(
    await piecesFrom(
      source,
      JSON.stringify(
        { schemaVersion: 1, situations: [{ id: "s-1", text: "Situation.", createdAtIso: T0, expiresAtIso: "2030-01-01T00:00:00.000Z" }] },
        null,
        2,
      ),
    ),
  );
  const { deps, cleanup } = await freshDeps();
  try {
    const result = await applyBackup(zip, "replace", deps);
    assert.equal(result.applied.conversations, 1);
    assert.equal(result.applied.messages, 2);
    assert.equal(result.applied.situations, 1);
    assert.equal(result.applied.personaPacks, 1);
    assert.deepEqual(result.providersNeedingCredentials, ["local"], "the restored profile must demand its credential");
    assert.equal(result.verified, true);

    // The restored transcript snapshot is byte-identical to the source's.
    assert.equal(await deps.store.exportEverything(), await source.exportEverything());
    // The config documents landed.
    assert.equal(await readFile(join(deps.dataDir, "providers.json"), "utf8"), PROVIDERS_DOC);
    // The persona pack landed.
    assert.equal(await readFile(join(deps.personaDir, "mine", "base.md"), "utf8"), "You are mine.");
  } finally {
    await cleanup();
  }
});

test("restore: merge-skip keeps existing rows and packs, adds new ones", async () => {
  const source = await populatedStore();
  const zip = createBackupZip(await piecesFrom(source));
  const { deps, cleanup } = await freshDeps();
  try {
    const existing = await deps.store.createConversation(
      { title: "Already here", personaId: "p", providerProfileId: "local", surface: "web" },
      T0,
    );
    await mkdir(join(deps.personaDir, "mine"), { recursive: true });
    await writeFile(join(deps.personaDir, "mine", "base.md"), "The ORIGINAL mine.", "utf8");

    const result = await applyBackup(zip, "merge-skip", deps);
    assert.equal(result.applied.conversations, 1, "the backed-up conversation was added");
    const all = await deps.store.listConversations(true);
    assert.equal(all.length, 2, "merge lost the pre-existing conversation");
    assert.ok(all.some((c) => c.id === existing.id));
    // The pre-existing pack was skipped, not overwritten.
    assert.equal(await readFile(join(deps.personaDir, "mine", "base.md"), "utf8"), "The ORIGINAL mine.");
  } finally {
    await cleanup();
  }
});

test("restore: a failing snapshot rolls EVERYTHING back", async () => {
  const source = await populatedStore();
  const pieces = await piecesFrom(source);
  // Corrupt the transcripts with a duplicate message id - the manifest hash
  // is computed over the corrupted content, so inspection passes and the
  // failure happens at the LAST step, inside the store transaction.
  const parsed = JSON.parse(pieces.transcripts) as { messages: { id: string }[] };
  parsed.messages.push({ ...parsed.messages[0]! });
  const zip = createBackupZip({ ...pieces, transcripts: JSON.stringify(parsed, null, 2) });

  const { deps, cleanup } = await freshDeps();
  try {
    const keep = await deps.store.createConversation(
      { title: "Must survive", personaId: "p", providerProfileId: "x", surface: "web" },
      T0,
    );
    await writeFile(join(deps.dataDir, "providers.json"), '{"schemaVersion":1,"profiles":[]}', "utf8");
    await deps.situations.create("Original situation.", T0, "2030-01-01T00:00:00.000Z");

    await assert.rejects(() => applyBackup(zip, "replace", deps));

    // Store untouched.
    const conversations = await deps.store.listConversations(true);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]!.id, keep.id);
    // providers.json rolled back to its original content.
    assert.equal(await readFile(join(deps.dataDir, "providers.json"), "utf8"), '{"schemaVersion":1,"profiles":[]}');
    // Situations rolled back.
    const situations = JSON.parse(await deps.situations.exportAll()) as { situations: { text: string }[] };
    assert.equal(situations.situations.length, 1);
    assert.equal(situations.situations[0]!.text, "Original situation.");
    // No stray staging or bak litter.
    assert.ok(!existsSync(`${deps.personaDir}.restore-new`));
    assert.ok(!existsSync(`${deps.personaDir}.restore-bak`));
  } finally {
    await cleanup();
  }
});

test("backup: a pack path the product accepts is a pack path backup accepts", async () => {
  // Interior dots in a legal segment ("a..b.md") pass the persona grammar;
  // the backup grammar must not be subtly stricter, or state the product
  // itself stored would make the whole backup uncreatable.
  const store = await populatedStore();
  const pieces = await piecesFrom(store);
  const zip = createBackupZip({
    ...pieces,
    personaFiles: new Map([
      ...pieces.personaFiles,
      ["personas/mine/notes/a..b.md", "Interior dots are a legal filename."],
    ]),
  });
  const inspection = inspectBackupZip(zip);
  assert.ok(inspection.entries.has("personas/mine/notes/a..b.md"));

  const { deps, cleanup } = await freshDeps();
  try {
    await applyBackup(zip, "replace", deps);
    assert.equal(
      await readFile(join(deps.personaDir, "mine", "notes", "a..b.md"), "utf8"),
      "Interior dots are a legal filename.",
    );
  } finally {
    await cleanup();
  }
});

test("inspection: tampered manifest counts are refused BEFORE anything applies", async () => {
  const store = await populatedStore();
  const good = createBackupZip(await piecesFrom(store));
  const entries = new Map(inspectBackupZip(good).entries);
  const manifest = JSON.parse(entries.get("backup.json")!) as { counts: Record<string, number> };
  manifest.counts["conversations"] = 999; // a lie the hashes cannot see
  entries.set("backup.json", JSON.stringify(manifest, null, 2));
  assert.throws(
    () => inspectBackupZip(writePackZip(entries)),
    (error: unknown) => error instanceof BackupError && error.code === "integrity_mismatch",
    "the manifest lied about its counts and inspection believed it",
  );
});

test("restore: duplicate situation ids are refused; merge-skip really skips situations", async () => {
  const store = await populatedStore();
  const duplicated = JSON.stringify(
    {
      schemaVersion: 1,
      situations: [
        { id: "s-dup", text: "One.", createdAtIso: T0, expiresAtIso: "2030-01-01T00:00:00.000Z" },
        { id: "s-dup", text: "Two.", createdAtIso: T0, expiresAtIso: "2030-01-01T00:00:00.000Z" },
      ],
    },
    null,
    2,
  );
  const dupZip = createBackupZip(await piecesFrom(store, duplicated));
  const { deps, cleanup } = await freshDeps();
  try {
    await assert.rejects(
      () => applyBackup(dupZip, "replace", deps),
      (error: unknown) => error instanceof BackupError && error.code === "invalid_content",
    );

    // merge-skip: an archive situation whose id already exists locally must
    // NOT overwrite the local text.
    await deps.situations.create("The LOCAL text.", T0, "2030-01-01T00:00:00.000Z");
    const localId = (JSON.parse(await deps.situations.exportAll()) as { situations: { id: string }[] })
      .situations[0]!.id;
    const overlapping = JSON.stringify(
      {
        schemaVersion: 1,
        situations: [
          { id: localId, text: "The ARCHIVE text.", createdAtIso: T0, expiresAtIso: "2030-01-01T00:00:00.000Z" },
          { id: "s-new", text: "A new one.", createdAtIso: T0, expiresAtIso: "2030-01-01T00:00:00.000Z" },
        ],
      },
      null,
      2,
    );
    const mergeZip = createBackupZip(await piecesFrom(store, overlapping));
    const result = await applyBackup(mergeZip, "merge-skip", deps);
    const after = JSON.parse(await deps.situations.exportAll()) as {
      situations: { id: string; text: string }[];
    };
    assert.equal(after.situations.find((s) => s.id === localId)!.text, "The LOCAL text.");
    assert.ok(after.situations.some((s) => s.text === "A new one."));
    assert.equal(result.applied.situations, 1, "only the genuinely new situation counts as applied");

    // And merge-skip is honest about what it can verify.
    assert.equal(result.verified, false);
    assert.match(result.verification, /merge-skip/);
  } finally {
    await cleanup();
  }
});

test("inspection: hostile archives are refused on shape, hash, schema, and coverage", async () => {
  const store = await populatedStore();
  const good = createBackupZip(await piecesFrom(store));
  const goodEntries = inspectBackupZip(good).entries;

  // Foreign paths cannot exist in the format.
  for (const name of ["../escape.json", "/etc/passwd", "C:\\evil", "personas/../x", "notes.txt"]) {
    const entries = new Map(goodEntries);
    entries.set(name, "x");
    const zip = writePackZip(entries);
    assert.throws(
      () => inspectBackupZip(zip),
      (error: unknown) => error instanceof BackupError,
      `${name} was accepted`,
    );
  }

  // An entry the manifest does not account for is refused.
  {
    const entries = new Map(goodEntries);
    entries.set("personas/extra/persona.json", "{}");
    assert.throws(
      () => inspectBackupZip(writePackZip(entries)),
      (error: unknown) => error instanceof BackupError && error.code === "foreign_entry",
    );
  }

  // A tampered entry fails its manifest hash.
  {
    const entries = new Map(goodEntries);
    entries.set("situations.json", entries.get("situations.json")! + " ");
    assert.throws(
      () => inspectBackupZip(writePackZip(entries)),
      (error: unknown) => error instanceof BackupError && error.code === "integrity_mismatch",
    );
  }

  // A listed-but-missing entry is refused.
  {
    const entries = new Map(goodEntries);
    entries.delete("telegram.json");
    assert.throws(
      () => inspectBackupZip(writePackZip(entries)),
      (error: unknown) => error instanceof BackupError && error.code === "missing_entry",
    );
  }

  // An unsupported schema version is refused with its number named.
  {
    const entries = new Map(goodEntries);
    const manifest = JSON.parse(entries.get("backup.json")!) as { schemaVersion: number };
    manifest.schemaVersion = 99;
    entries.set("backup.json", JSON.stringify(manifest));
    assert.throws(
      () => inspectBackupZip(writePackZip(entries)),
      (error: unknown) => error instanceof BackupError && error.code === "unsupported_schema",
    );
  }
});
