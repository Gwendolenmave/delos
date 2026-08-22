/**
 * Persona creation, import and export.
 *
 * Four ways a persona comes to exist locally, none of which requires an LLM:
 *
 *   - the WIZARD: concrete fields in, a valid pack out, every block plain
 *     Markdown the user can edit afterwards;
 *   - DIRECTORY import: the hardened filesystem loader;
 *   - ZIP import: the paranoid archive reader, then the same manifest rules -
 *     a ZIP cannot express anything a directory could not;
 *   - PASTED PROMPT: one block of text becomes a clearly-labelled basic pack
 *     the user can organise later.
 *
 * Export is the inverse and deliberately lossy in one direction only: a pack
 * export contains the manifest and blocks and NOTHING else. There is no
 * field in the format for secrets, transcripts, local paths or provider
 * configuration, so exclusion is structural rather than filtered.
 */

import {
  parseContextualRules,
  parsePersonaManifest,
  PersonaPackError,
  type PersonaManifest,
} from "../../core/domain/persona-pack.js";
import type { LoadedPersonaPack } from "../../core/services/variant-resolver.js";
import { readPackZip, writePackZip } from "./pack-archive.js";
import { MANIFEST_FILENAME } from "./filesystem-pack-loader.js";

export interface WizardFields {
  readonly id: string;
  readonly displayName?: string;
  /** "Who are you?" - becomes base/identity.md */
  readonly identity: string;
  /** "What are you to the person you talk with?" - becomes base/relationship.md */
  readonly relationship?: string;
  /** "How do you speak?" - becomes base/response-style.md */
  readonly style?: string;
  readonly language?: string;
}

/** Build a valid pack from concrete wizard fields. No model call involved. */
export function createPackFromWizard(fields: WizardFields): LoadedPersonaPack {
  const blocks = new Map<string, string>();
  const base: string[] = [];

  blocks.set("base/identity.md", fields.identity.trim() + "\n");
  base.push("base/identity.md");
  if (fields.relationship !== undefined && fields.relationship.trim().length > 0) {
    blocks.set("base/relationship.md", fields.relationship.trim() + "\n");
    base.push("base/relationship.md");
  }
  if (fields.style !== undefined && fields.style.trim().length > 0) {
    blocks.set("base/response-style.md", fields.style.trim() + "\n");
    base.push("base/response-style.md");
  }

  const manifest = parsePersonaManifest(
    {
      schemaVersion: 1,
      id: fields.id,
      ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
      ...(fields.language === undefined ? {} : { language: fields.language }),
      base,
    },
    [...blocks.keys()],
  );
  return { manifest, blocks, rules: [] };
}

/**
 * Convert one pasted prompt into a basic pack, labelled as exactly that.
 * The description says where it came from; nothing pretends it was authored
 * as a structured persona.
 */
export function createPackFromPastedPrompt(id: string, pasted: string): LoadedPersonaPack {
  if (pasted.trim().length === 0) {
    throw new PersonaPackError("field_invalid", "The pasted prompt is empty.");
  }
  const blocks = new Map<string, string>([["base/imported.md", pasted.trim() + "\n"]]);
  const manifest = parsePersonaManifest(
    {
      schemaVersion: 1,
      id,
      displayName: id,
      description:
        "A basic imported persona, created from a single pasted prompt. " +
        "Organise it into separate blocks whenever you like.",
      base: ["base/imported.md"],
    },
    [...blocks.keys()],
  );
  return { manifest, blocks, rules: [] };
}

/** Import Markdown/text files as a basic pack, one block per file, in order. */
export function createPackFromTextFiles(
  id: string,
  files: readonly { readonly name: string; readonly content: string }[],
): LoadedPersonaPack {
  if (files.length === 0) {
    throw new PersonaPackError("field_invalid", "No files to import.");
  }
  const blocks = new Map<string, string>();
  const base: string[] = [];
  for (const file of files) {
    const stem = file.name.replace(/\.(md|txt|text)$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    if (stem.length === 0) {
      throw new PersonaPackError("field_invalid", `Cannot derive a block name from ${file.name}`);
    }
    const path = `base/${stem}.md`;
    if (blocks.has(path)) {
      throw new PersonaPackError("duplicate_id", `Two files map to ${path}`);
    }
    blocks.set(path, file.content.trim() + "\n");
    base.push(path);
  }
  const manifest = parsePersonaManifest(
    {
      schemaVersion: 1,
      id,
      description: "A basic imported persona, created from plain prompt files.",
      base,
    },
    [...blocks.keys()],
  );
  return { manifest, blocks, rules: [] };
}

/** Import a hardened pack ZIP. */
export function importPackZip(zip: Buffer): LoadedPersonaPack {
  const entries = readPackZip(zip);
  const manifestText = entries.get(MANIFEST_FILENAME);
  let document: unknown;
  try {
    document = JSON.parse(manifestText ?? "");
  } catch {
    throw new PersonaPackError("field_invalid", `${MANIFEST_FILENAME} is not valid JSON`);
  }
  const claimable = [...entries.keys()].filter((n) => n !== MANIFEST_FILENAME);
  const manifest = parsePersonaManifest(document, claimable);

  const claimed = new Set<string>([
    ...manifest.base.map((b) => b.path),
    ...manifest.variants.map((v) => v.path),
    ...manifest.overlays.map((o) => o.path),
    ...(manifest.rulesPath === undefined ? [] : [manifest.rulesPath]),
  ]);
  for (const name of claimable) {
    if (!claimed.has(name)) {
      throw new PersonaPackError(
        "path_invalid",
        `${name} is present in the archive but not named by the manifest`,
      );
    }
  }

  const blocks = new Map<string, string>();
  for (const path of claimed) blocks.set(path, entries.get(path) ?? "");

  let rules: LoadedPersonaPack["rules"] = [];
  if (manifest.rulesPath !== undefined) {
    let rulesDocument: unknown;
    try {
      rulesDocument = JSON.parse(blocks.get(manifest.rulesPath) ?? "");
    } catch {
      throw new PersonaPackError("field_invalid", `${manifest.rulesPath} is not valid JSON`);
    }
    rules = parseContextualRules(rulesDocument, manifest);
  }
  return { manifest, blocks, rules };
}

/**
 * Export a pack as a deterministic ZIP. Same pack, same bytes: the writer
 * sorts entries and fixes every timestamp, and the manifest is re-serialised
 * canonically rather than echoing whatever formatting it arrived with.
 */
export function exportPackZip(pack: LoadedPersonaPack): Buffer {
  const entries = new Map<string, string>();
  entries.set(MANIFEST_FILENAME, canonicalManifestJson(pack.manifest));
  for (const [path, content] of pack.blocks) entries.set(path, content);
  return writePackZip(entries);
}

/** Duplicate a pack under a new id, for edit-a-copy workflows. */
export function duplicatePack(pack: LoadedPersonaPack, newId: string): LoadedPersonaPack {
  const manifest = parsePersonaManifest(
    { ...JSON.parse(canonicalManifestJson(pack.manifest)) as Record<string, unknown>, id: newId, displayName: `${pack.manifest.displayName} (copy)` },
    [...pack.blocks.keys()],
  );
  return { manifest, blocks: new Map(pack.blocks), rules: pack.rules };
}

function canonicalManifestJson(manifest: PersonaManifest): string {
  // Stable field order, two-space indent, trailing newline.
  const doc: Record<string, unknown> = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    displayName: manifest.displayName,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.language === undefined ? {} : { language: manifest.language }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    base: manifest.base.map((b) => b.path),
    ...(manifest.variants.length === 0
      ? {}
      : {
          variants: manifest.variants.map((v) => ({
            id: v.id,
            path: v.path,
            displayName: v.displayName,
            policy: v.policy,
            priority: v.priority,
            ...(v.surfaces === undefined ? {} : { surfaces: v.surfaces }),
            ...(v.description === undefined ? {} : { description: v.description }),
          })),
        }),
    ...(manifest.overlays.length === 0
      ? {}
      : { overlays: manifest.overlays.map((o) => ({ surface: o.surface, path: o.path })) }),
    ...(manifest.rulesPath === undefined ? {} : { rules: manifest.rulesPath }),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}
