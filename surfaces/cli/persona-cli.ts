/**
 * `delos persona <validate|snapshot|test> <packDir>` - the developer tools
 * for persona integrity (13.4).
 *
 * validate  - structural validation through the real loader, plus the
 *             variant leakage checks. Exit 1 on any problem.
 * snapshot  - the deterministic pack hash and the content-free resolved
 *             manifest, as stable JSON on stdout.
 * test      - synthetic evaluation cases through the built-in OFFLINE
 *             provider (no network, ever, unless a future caller injects a
 *             real provider deliberately). Structural judgements only.
 *
 * Every command can append one PUBLIC-SAFE evidence record - ids, hashes,
 * booleans, model identities; never persona content - to an append-only
 * JSONL file via --evidence <path>. Records are appended, never rewritten.
 */

import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { loadPersonaPack } from "../../adapters/persona/filesystem-pack-loader.js";
import {
  createSyntheticOfflineProvider,
  DEFAULT_SYNTHETIC_CASES,
  hashPack,
  runLeakageChecks,
  runSyntheticCases,
  snapshotPack,
} from "../../core/services/persona-tools.js";

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface PersonaCliStreams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE = `delos persona - persona integrity tools

Usage:
  delos persona validate <packDir> [--evidence <file>]
  delos persona snapshot <packDir> [--evidence <file>]
  delos persona test     <packDir> [--evidence <file>]

validate: structural validation plus variant leakage checks (exit 1 on any problem)
snapshot: deterministic pack hash and content-free manifest as JSON
test:     synthetic cases through the built-in offline provider (no network)

--evidence appends ONE public-safe JSONL record (ids, hashes, booleans -
never persona content) to the named append-only file.`;

export async function runPersonaCli(
  argv: readonly string[],
  streams: PersonaCliStreams,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<number> {
  const [command, packDirRaw, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    streams.stdout(USAGE + "\n");
    return command === undefined ? 2 : 0;
  }
  if (!["validate", "snapshot", "test"].includes(command) || packDirRaw === undefined) {
    streams.stderr(USAGE + "\n");
    return 2;
  }
  let evidencePath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--evidence") {
      evidencePath = rest[++i];
      if (evidencePath === undefined) {
        streams.stderr("--evidence needs a file path.\n");
        return 2;
      }
    }
  }
  const packDir = resolve(packDirRaw);

  let pack;
  try {
    pack = await loadPersonaPack({ packDir });
  } catch (error) {
    streams.stderr(`The pack did not validate: ${error instanceof Error ? error.message : "unknown error"}\n`);
    if (evidencePath !== undefined) {
      await appendEvidence(evidencePath, {
        atIso: nowIso(),
        tool: `persona-${command}`,
        packDir: packDirRaw,
        ok: false,
        problem: "load-failed",
      });
    }
    return 1;
  }
  const packHash = hashPack(pack, sha256hex);

  if (command === "validate") {
    const leakage = runLeakageChecks(pack);
    const report = {
      packId: pack.manifest.id,
      packHash,
      structurallyValid: true,
      leakage: leakage.checks,
      ok: leakage.ok,
    };
    streams.stdout(JSON.stringify(report, null, 2) + "\n");
    if (evidencePath !== undefined) {
      await appendEvidence(evidencePath, {
        atIso: nowIso(),
        tool: "persona-validate",
        packId: pack.manifest.id,
        packHash,
        ok: leakage.ok,
        leakedVariants: leakage.checks.filter((c) => c.leaked).map((c) => c.variantId),
      });
    }
    return leakage.ok ? 0 : 1;
  }

  if (command === "snapshot") {
    const snapshot = snapshotPack(pack, sha256hex);
    streams.stdout(JSON.stringify(snapshot, null, 2) + "\n");
    if (evidencePath !== undefined) {
      await appendEvidence(evidencePath, {
        atIso: nowIso(),
        tool: "persona-snapshot",
        packId: snapshot.packId,
        packHash: snapshot.packHash,
        blockCount: snapshot.blocks.length,
        variantCount: snapshot.variants.length,
        ok: true,
      });
    }
    return 0;
  }

  // test: synthetic cases through the OFFLINE provider. Deliberately no
  // flag selects a real provider here - automated paths stay offline; a
  // future interactive integration must be its own explicit decision.
  const provider = createSyntheticOfflineProvider();
  const results = await runSyntheticCases(pack, provider, DEFAULT_SYNTHETIC_CASES);
  const ok = results.every((r) => r.ok);
  streams.stdout(
    JSON.stringify({ packId: pack.manifest.id, packHash, provider: provider.profileId, results, ok }, null, 2) +
      "\n",
  );
  if (evidencePath !== undefined) {
    await appendEvidence(evidencePath, {
      atIso: nowIso(),
      tool: "persona-test",
      packId: pack.manifest.id,
      packHash,
      provider: provider.profileId,
      requestedModel: results[0]?.requestedModel,
      servedModel: results[0]?.servedModel,
      cases: results.map((r) => ({ name: r.name, ok: r.ok })),
      ok,
    });
  }
  return ok ? 0 : 1;
}

async function appendEvidence(path: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}
