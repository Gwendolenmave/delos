/**
 * Persona packs - manifest, loader hardening, variant resolution, and the
 * shipped Arti pack. All fixture packs are synthetic and built in temporary // scan-allow-persona
 * directories; forbidden patterns are assembled from fragments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePersonaManifest,
  parseContextualRules,
  PersonaPackError,
  validatePackPath,
} from "../core/domain/persona-pack.js";
import {
  loadPersonaPack,
  MAX_FILE_BYTES,
} from "../adapters/persona/filesystem-pack-loader.js";
import {
  resolveVariants,
  type LoadedPersonaPack,
  type VariantSessionState,
} from "../core/services/variant-resolver.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- helpers -----------------------------------------------------------------

function manifestDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "test-persona",
    base: ["base/identity.md"],
    variants: [],
    overlays: [],
    ...overrides,
  };
}

const PRESENT = ["base/identity.md", "variants/warm.md", "rules/rules.json", "overlays/cli.md"];

function expectPackFailure(fn: () => unknown, code: string): PersonaPackError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PersonaPackError, `expected PersonaPackError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected ${code}, but it validated`);
}

async function writePack(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "delos-pack-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const MINIMAL_PACK: Record<string, string> = {
  "persona.json": JSON.stringify({
    schemaVersion: 1,
    id: "mini",
    base: ["base/identity.md"],
    variants: [
      { id: "warm", path: "variants/warm.md", policy: "manual", priority: 5 },
      { id: "steady", path: "variants/steady.md", policy: "contextual", priority: 1 },
    ],
    rules: "rules/activation.json",
  }),
  "base/identity.md": "You are a synthetic test persona.\n",
  "variants/warm.md": "Warmer register.\n",
  "variants/steady.md": "Steady register.\n",
  "rules/activation.json": JSON.stringify({
    rules: [{ variantId: "steady", anyOf: ["difficult", "grief"] }],
  }),
};

// --- manifest validation -----------------------------------------------------

test("a valid manifest parses with derived block names", () => {
  const m = parsePersonaManifest(manifestDoc(), PRESENT);
  assert.equal(m.id, "test-persona");
  assert.equal(m.base[0]?.name, "identity");
});

test("path traversal, absolutes, hidden and non-text entries are refused", () => {
  for (const bad of [
    "../outside.md",
    "base/../../etc/passwd.md",
    "/etc/passwd.md",
    "C:/windows/x.md",
    "base\\identity.md",
    ".hidden/block.md",
    "base/.secret.md",
    "base/run.sh",
    "base/tool.exe.md/../x.md",
    "a/b/c/d/e/f/g.md",
  ]) {
    expectPackFailure(() => validatePackPath(bad, "test"), "path_invalid");
  }
});

test("a manifest naming an absent file is refused", () => {
  expectPackFailure(
    () => parsePersonaManifest(manifestDoc({ base: ["base/missing.md"] }), PRESENT),
    "path_invalid",
  );
});

test("duplicate variant ids and duplicate base paths are refused", () => {
  expectPackFailure(
    () =>
      parsePersonaManifest(
        manifestDoc({
          variants: [
            { id: "w", path: "variants/warm.md", policy: "manual", priority: 0 },
            { id: "w", path: "variants/warm.md", policy: "manual", priority: 0 },
          ],
        }),
        PRESENT,
      ),
    "duplicate_id",
  );
  expectPackFailure(
    () => parsePersonaManifest(manifestDoc({ base: ["base/identity.md", "base/identity.md"] }), PRESENT),
    "duplicate_id",
  );
});

test("secret-bearing metadata is refused at any depth", () => {
  const token = "sk-" + "synthetic-manifest-token";
  expectPackFailure(
    () => parsePersonaManifest(manifestDoc({ metadata: { nested: { apiKey: token } } }), PRESENT),
    "secret_in_manifest",
  );
});

test("an email address in author metadata is refused", () => {
  expectPackFailure(
    () => parsePersonaManifest(manifestDoc({ author: "someone <a@" + "example.org>" }), PRESENT),
    "field_invalid",
  );
});

test("an unsupported schema version is refused, not reinterpreted", () => {
  expectPackFailure(
    () => parsePersonaManifest(manifestDoc({ schemaVersion: 2 }), PRESENT),
    "schema_unsupported",
  );
});

test("contextual rules must reference contextual variants of this pack", () => {
  const m = parsePersonaManifest(
    manifestDoc({
      variants: [{ id: "warm", path: "variants/warm.md", policy: "manual", priority: 0 }],
    }),
    PRESENT,
  );
  expectPackFailure(
    () => parseContextualRules({ rules: [{ variantId: "warm", anyOf: ["x"] }] }, m),
    "field_invalid",
  );
});

// --- loader hardening --------------------------------------------------------

test("a valid pack directory loads with every claimed block", async () => {
  const { dir, cleanup } = await writePack(MINIMAL_PACK);
  try {
    const pack = await loadPersonaPack({ packDir: dir });
    assert.equal(pack.manifest.id, "mini");
    assert.equal(pack.blocks.get("base/identity.md"), "You are a synthetic test persona.\n");
    assert.equal(pack.rules[0]?.variantId, "steady");
  } finally {
    await cleanup();
  }
});

test("a symlink anywhere in the pack is refused, wherever it points", async () => {
  const { dir, cleanup } = await writePack(MINIMAL_PACK);
  try {
    await symlink(join(dir, "base/identity.md"), join(dir, "base/link.md"));
    await assert.rejects(
      () => loadPersonaPack({ packDir: dir }),
      (e: unknown) => e instanceof PersonaPackError && /symlink/.test(e.message),
    );
  } finally {
    await cleanup();
  }
});

test("an unclaimed file cannot ride along", async () => {
  const { dir, cleanup } = await writePack({
    ...MINIMAL_PACK,
    "base/stowaway.md": "content nobody reviewed\n",
  });
  try {
    await assert.rejects(
      () => loadPersonaPack({ packDir: dir }),
      (e: unknown) => e instanceof PersonaPackError && /not named by the manifest/.test(e.message),
    );
  } finally {
    await cleanup();
  }
});

test("binary content and oversized files are refused", async () => {
  const withBinary = await writePack({
    ...MINIMAL_PACK,
    "persona.json": JSON.stringify({
      schemaVersion: 1,
      id: "mini",
      base: ["base/identity.md", "base/blob.md"],
    }),
    "base/blob.md": "text with a NUL \u0000 byte\n",
  });
  try {
    await assert.rejects(
      () => loadPersonaPack({ packDir: withBinary.dir }),
      (e: unknown) => e instanceof PersonaPackError && /binary|not named/.test(e.message),
    );
  } finally {
    await withBinary.cleanup();
  }

  const oversized = await writePack({
    ...MINIMAL_PACK,
    "persona.json": JSON.stringify({ schemaVersion: 1, id: "mini", base: ["base/big.md"] }),
    "base/big.md": "x".repeat(MAX_FILE_BYTES + 1),
  });
  try {
    await assert.rejects(
      () => loadPersonaPack({ packDir: oversized.dir }),
      (e: unknown) => e instanceof PersonaPackError && /per-file limit/.test(e.message),
    );
  } finally {
    await oversized.cleanup();
  }
});

// --- variant resolution ------------------------------------------------------

async function loadedMinimal(): Promise<{ pack: LoadedPersonaPack; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await writePack(MINIMAL_PACK);
  const pack = await loadPersonaPack({ packDir: dir });
  return { pack, cleanup };
}

function state(overrides: Partial<VariantSessionState> = {}): VariantSessionState {
  return {
    surface: "cli",
    manualEnabled: [],
    manualDisabled: [],
    currentUserText: "An ordinary message.",
    ...overrides,
  };
}

test("a manual variant never activates without an explicit enable", async () => {
  const { pack, cleanup } = await loadedMinimal();
  try {
    // Even a message stuffed with suggestive terms cannot activate it.
    const r = resolveVariants(pack, state({ currentUserText: "warm warmer closeness intimacy" }));
    assert.ok(!r.blocks.some((b) => b.name === "variant:warm"), "manual variant auto-activated");
    assert.ok(
      r.metadata.inactive.some((i) => i.id === "warm" && /explicit/.test(i.reason)),
      "the reason must say an explicit enable is required",
    );
  } finally {
    await cleanup();
  }
});

test("manual enable activates; manual disable wins over everything", async () => {
  const { pack, cleanup } = await loadedMinimal();
  try {
    const on = resolveVariants(pack, state({ manualEnabled: ["warm"] }));
    assert.ok(on.blocks.some((b) => b.name === "variant:warm"));
    assert.ok(on.metadata.variants.some((v) => v.id === "warm" && /user/.test(v.reason)));

    // Disabled wins even when simultaneously enabled AND contextually matched.
    const off = resolveVariants(
      pack,
      state({
        manualEnabled: ["warm", "steady"],
        manualDisabled: ["warm", "steady"],
        currentUserText: "this is difficult",
      }),
    );
    assert.ok(!off.blocks.some((b) => b.name.startsWith("variant:")));
    assert.equal(off.metadata.inactive.filter((i) => /disabled/.test(i.reason)).length, 2);
  } finally {
    await cleanup();
  }
});

test("contextual activation is literal, visible and reason-carrying", async () => {
  const { pack, cleanup } = await loadedMinimal();
  try {
    const hit = resolveVariants(pack, state({ currentUserText: "Today was DIFFICULT for me." }));
    const steady = hit.blocks.find((b) => b.name === "variant:steady");
    assert.ok(steady, "the contextual variant should load");
    assert.deepEqual(steady?.reason, { kind: "contextual", matchedTerm: "difficult" });

    const miss = resolveVariants(pack, state({ currentUserText: "Today was fine." }));
    assert.ok(!miss.blocks.some((b) => b.name === "variant:steady"));
    assert.ok(miss.metadata.inactive.some((i) => i.id === "steady" && /no rule term/.test(i.reason)));
  } finally {
    await cleanup();
  }
});

test("resolution order: base, then contextual, then manual, priority ascending", async () => {
  const { pack, cleanup } = await loadedMinimal();
  try {
    const r = resolveVariants(
      pack,
      state({ manualEnabled: ["warm"], currentUserText: "grief" }),
    );
    const names = r.blocks.map((b) => b.name);
    // steady has priority 1, warm 5 -> steady first among variants; base first of all.
    assert.deepEqual(names, ["identity", "variant:steady", "variant:warm"]);
  } finally {
    await cleanup();
  }
});

test("a contextual variant never drags the manual one in", async () => {
  const { pack, cleanup } = await loadedMinimal();
  try {
    const r = resolveVariants(pack, state({ currentUserText: "grief and difficulty" }));
    assert.ok(r.blocks.some((b) => b.name === "variant:steady"));
    assert.ok(!r.blocks.some((b) => b.name === "variant:warm"), "serious is not the same as close");
  } finally {
    await cleanup();
  }
});

// --- the shipped Arti pack --------------------------------------------------- // scan-allow-persona

test("the shipped Arti pack loads, and its blocks match the compat prompts", async () => { // scan-allow-persona
  const packDir = join(REPO_ROOT, "delos-public-staging", "personas", "arti"); // scan-allow-persona
  // Resolve against the actual repo layout: tests run from build/tests inside
  // the export, so walk up from this file instead.
  const localPack = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas", "arti"); // scan-allow-persona
  const pack = await loadPersonaPack({ packDir: localPack }).catch(() =>
    loadPersonaPack({ packDir }),
  );

  assert.equal(pack.manifest.id, "arti"); // scan-allow-persona
  assert.equal(pack.manifest.base.length, 3);
  assert.deepEqual(
    pack.manifest.base.map((b) => b.name),
    ["identity", "relationship", "response-style"],
  );

  const intimacy = pack.manifest.variants.find((v) => v.id === "intimacy");
  assert.equal(intimacy?.policy, "manual", "intimacy must be manual-only");
  const sensitive = pack.manifest.variants.find((v) => v.id === "sensitive-content");
  assert.equal(sensitive?.policy, "contextual");

  // No contextual rule may reference intimacy - the resolver forbids
  // activation anyway, but the shipped pack must not even try.
  assert.ok(pack.rules.every((r) => r.variantId !== "intimacy"));

  // The shipped variants make no policy-override claims and carry no private
  // names. (The scanner enforces the private names repo-wide; this asserts
  // the specific §8 contract inside the pack content itself.)
  for (const [path, text] of pack.blocks) {
    const mentions = /override[\s\S]{0,60}provider policy/i.test(text);
    const disclaims = /does not\s+(?:override|claim to\s+override)|not\s+claim to\s+override/i.test(text);
    assert.ok(!mentions || disclaims, `${path} appears to claim policy override`);
  }
});

test("shipped Arti: intimacy stays off under contextual pressure, on only by hand", async () => { // scan-allow-persona
  const localPack = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "personas", "arti"); // scan-allow-persona
  const pack = await loadPersonaPack({ packDir: localPack });

  const pressured = resolveVariants(pack, {
    surface: "cli",
    manualEnabled: [],
    manualDisabled: [],
    currentUserText: "I am grieving; someone died and the funeral is tomorrow.",
  });
  assert.ok(
    pressured.blocks.some((b) => b.name === "variant:sensitive-content"),
    "sensitive-content should activate by its visible rule",
  );
  assert.ok(
    !pressured.blocks.some((b) => b.name === "variant:intimacy"),
    "intimacy must not ride in on a serious topic",
  );

  const enabled = resolveVariants(pack, {
    surface: "cli",
    manualEnabled: ["intimacy"],
    manualDisabled: [],
    currentUserText: "hello",
  });
  assert.ok(enabled.blocks.some((b) => b.name === "variant:intimacy"));

  const disabled = resolveVariants(pack, {
    surface: "cli",
    manualEnabled: ["intimacy"],
    manualDisabled: ["intimacy"],
    currentUserText: "hello",
  });
  assert.ok(!disabled.blocks.some((b) => b.name === "variant:intimacy"), "disable wins immediately");
});
