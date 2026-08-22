/**
 * Filesystem identity adapter.
 *
 * ONE implementation of an identity source: a directory of Markdown files.
 * It is not the only possible one, and core does not depend on it. Core
 * consumes `PromptBundle`; a future editor, imported profile bundle, or synced
 * source produces the same shape without inventing file paths.
 *
 * This module finds the files, reads them, validates them, orders them
 * deterministically, and returns a bundle. That is all it does. It knows
 * nothing about providers, tokens, conversation history, runtime
 * configuration, personas, migration, or file watching.
 *
 * The three default file names are FUNCTIONAL names - identity, relationship,
 * response-style - so they may appear here. No persona name appears in this
 * module, its types, or its errors, because the persona is content and this
 * is code.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { PromptBundle, PromptSection } from "../../../core/domain/types.js";

/** A section that came from a file, carrying its filesystem provenance. */
export interface FilesystemPromptSection extends PromptSection {
  /** Path relative to the configured prompt root. */
  readonly path: string;
}

export interface FilesystemPromptBundle extends PromptBundle {
  readonly sections: readonly FilesystemPromptSection[];
}

/**
 * Default sections, in the order they are stated to the model when present.
 *
 * Identity and relationship come first because everything after them is read
 * in their light; response-style comes last so its rules govern the sections
 * above rather than only the ones that happen to precede it.
 *
 * None is required. A user may delete any of them and add any number of their
 * own - the loader will not pull them back toward this list.
 */
export const DEFAULT_SECTION_ORDER = [
  "identity",
  "relationship",
  "response-style",
] as const;

const MARKDOWN_SUFFIX = ".md";
const BOM = "﻿";

export type PromptLoadErrorKind =
  /** The configured prompt root does not exist. */
  | "prompt_root_missing"
  /** The prompt root exists but could not be inspected or listed. */
  | "prompt_root_unreadable"
  /** The configured prompt root exists but is not a directory. */
  | "prompt_root_not_a_directory"
  /** The prompt root contains no usable Markdown file. */
  | "no_prompt_files"
  /** Two files claim the same logical section name. */
  | "duplicate_section"
  /** A candidate file could not be read. */
  | "unreadable_file"
  /** A candidate file is not valid UTF-8. */
  | "invalid_utf8"
  /** A candidate file is empty, or contains only whitespace. */
  | "empty_file";

/**
 * A load failure that names what went wrong and where.
 *
 * Nothing is skipped silently: a file that looks like a prompt but cannot be
 * used is an error, because quietly dropping it would remove part of the
 * assistant's persona without telling anyone.
 */
export class PromptLoadError extends Error {
  constructor(
    readonly kind: PromptLoadErrorKind,
    message: string,
    /** Path relative to the prompt root, when the failure concerns one file. */
    readonly path?: string,
    /** All paths involved, when the failure concerns a set of files. */
    readonly paths?: readonly string[],
  ) {
    super(message);
    this.name = "PromptLoadError";
  }
}

export interface LoadPromptBundleOptions {
  /** Directory holding the prompt files. May live anywhere on disk. */
  promptRoot: string;
}

/** SHA-256 of raw bytes, hex encoded. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * True for files this loader considers prompt sections.
 *
 * Ignored, and not an error: hidden files, editor backups and temporary
 * files, and anything that is not Markdown. These are debris that appears in
 * a directory a human edits, and treating them as prompts would be worse than
 * ignoring them.
 *
 * The Markdown suffix is matched case-insensitively so `NOTES.MD` is a
 * section on every platform, not only on the ones with a case-insensitive
 * filesystem.
 */
function isCandidate(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (name.endsWith("~") || name.endsWith(".tmp") || name.endsWith(".bak")) return false;
  if (name.startsWith("#") && name.endsWith("#")) return false;
  return name.toLowerCase().endsWith(MARKDOWN_SUFFIX);
}

/** Section name is the file name without its Markdown suffix. */
function sectionName(fileName: string): string {
  return fileName.slice(0, -MARKDOWN_SUFFIX.length);
}

/**
 * Normalised identity of a section, used to detect collisions and to match
 * the defaults.
 *
 * Unicode NFC because the same name can be spelled with composed or
 * decomposed characters - macOS and Linux disagree about which one lands on
 * disk - and case-folded because filesystems disagree about case. Two files
 * that a user would call "the same section" must resolve to the same key on
 * every platform, or the assistant's identity would depend on where it runs.
 */
function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Order: the default sections first, in their fixed order, then every other
 * section sorted by name.
 *
 * Sorting is explicit and locale-independent. Directory enumeration order,
 * creation time and filesystem behaviour differ between machines, and a
 * persona whose sections silently reorder between two installations is not
 * the same persona.
 */
function orderSections(
  sections: FilesystemPromptSection[],
): FilesystemPromptSection[] {
  const defaultKeys = DEFAULT_SECTION_ORDER.map(collisionKey);
  const defaults: FilesystemPromptSection[] = [];
  for (const key of defaultKeys) {
    const found = sections.find((s) => collisionKey(s.name) === key);
    if (found !== undefined) defaults.push(found);
  }
  const rest = sections
    .filter((s) => !defaultKeys.includes(collisionKey(s.name)))
    .sort((a, b) => {
      const ka = collisionKey(a.name);
      const kb = collisionKey(b.name);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return [...defaults, ...rest];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Load every prompt section from `promptRoot`.
 *
 * Only direct children are read; subdirectories are ignored rather than
 * recursed, so a user can keep drafts or archives beside their prompts.
 *
 * **Entries inside the root that are symbolic links are not followed** - a
 * prompt root should describe itself, and following links would let a file
 * outside it become persona content without that being visible in the
 * directory listing.
 *
 * **The root itself MAY be a symbolic link.** It is resolved, deliberately:
 * pointing the prompt root at a synced or shared folder through a link is a
 * reasonable thing for a user to do, and they chose that path explicitly.
 * The distinction is intent - the root is configuration, its contents are not.
 */
export async function loadPromptBundle(
  options: LoadPromptBundleOptions,
): Promise<FilesystemPromptBundle> {
  const { promptRoot } = options;

  let rootStat;
  try {
    // stat() follows a symlinked root by design; see the note above.
    rootStat = await stat(promptRoot);
  } catch (error) {
    if (isEnoent(error)) {
      throw new PromptLoadError(
        "prompt_root_missing",
        `Prompt root does not exist: ${promptRoot}`,
      );
    }
    // Permissions, a broken mount, a loop: it is there but unusable. Reporting
    // "missing" would send the user looking for the wrong problem, and letting
    // the platform's own error escape would make it part of the contract.
    throw new PromptLoadError(
      "prompt_root_unreadable",
      `Prompt root exists but could not be inspected: ${promptRoot}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new PromptLoadError(
      "prompt_root_not_a_directory",
      `Prompt root is not a directory: ${promptRoot}`,
    );
  }

  let entries;
  try {
    entries = await readdir(promptRoot, { withFileTypes: true });
  } catch {
    throw new PromptLoadError(
      "prompt_root_unreadable",
      `Prompt root could not be listed: ${promptRoot}`,
    );
  }

  // --- discovery, and collision detection BEFORE anything is read ----------
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    if (!isCandidate(entry.name)) continue;
    candidates.push(entry.name);
  }

  const byKey = new Map<string, string[]>();
  for (const fileName of candidates) {
    const key = collisionKey(sectionName(fileName));
    const existing = byKey.get(key);
    if (existing) existing.push(fileName);
    else byKey.set(key, [fileName]);
  }
  for (const [key, fileNames] of byKey) {
    if (fileNames.length > 1) {
      // Picking one would make the persona depend on enumeration order, and
      // the loser would vanish without a word. Refuse, and name both.
      const listed = [...fileNames].sort().join(", ");
      throw new PromptLoadError(
        "duplicate_section",
        `Two or more files claim the logical section "${key}": ${listed}. ` +
          `Section names are compared case-insensitively and in Unicode NFC, ` +
          `so these collide on every platform. Rename or remove one.`,
        undefined,
        [...fileNames].sort(),
      );
    }
  }

  // --- read -----------------------------------------------------------------
  const sections: FilesystemPromptSection[] = [];
  for (const fileName of candidates) {
    // Direct children only, so the relative path is the file name and is
    // identical on every platform without separator normalisation.
    const relativePath = fileName;

    let bytes: Buffer;
    try {
      bytes = await readFile(join(promptRoot, fileName));
    } catch {
      throw new PromptLoadError(
        "unreadable_file",
        `Prompt file could not be read: ${relativePath}`,
        relativePath,
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PromptLoadError(
        "invalid_utf8",
        `Prompt file is not valid UTF-8: ${relativePath}`,
        relativePath,
      );
    }

    // A byte-order mark is an encoding artefact, not authored text, and would
    // otherwise become an invisible first character of the system prompt. It
    // is stripped from `content`; `sha256` still covers the real file bytes,
    // so the digest continues to identify the file as it exists on disk.
    const content = text.startsWith(BOM) ? text.slice(BOM.length) : text;

    if (content.trim().length === 0) {
      throw new PromptLoadError(
        "empty_file",
        `Prompt file is empty or contains only whitespace: ${relativePath}`,
        relativePath,
      );
    }

    sections.push({
      name: sectionName(fileName),
      path: relativePath,
      sha256: sha256Bytes(bytes),
      // Verbatim: never trimmed, never re-wrapped, no heading added.
      content,
    });
  }

  if (sections.length === 0) {
    throw new PromptLoadError(
      "no_prompt_files",
      `Prompt root contains no Markdown files: ${promptRoot}`,
    );
  }

  return { sections: orderSections(sections) };
}
