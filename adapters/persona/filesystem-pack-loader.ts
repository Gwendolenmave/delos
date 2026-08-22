/**
 * Load a persona pack from a directory, treating it as untrusted input.
 *
 * The manifest module owns what a pack may CLAIM; this loader owns what the
 * filesystem may actually CONTAIN. Everything is checked before a byte of
 * content is trusted:
 *
 *   - symlinks are refused, wherever they point (lstat, not stat);
 *   - device files, FIFOs and anything not a regular file or directory fail;
 *   - per-file and whole-pack size caps bound an archive-bomb import;
 *   - the enumeration never leaves the pack root;
 *   - content must be valid UTF-8 text with no NUL byte - "hidden executable
 *     content" is refused as a shape, not sniffed for by signature;
 *   - every file the pack contains is either the manifest, a manifest-claimed
 *     block, or refused as unclaimed - nothing rides along silently.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseContextualRules,
  parsePersonaManifest,
  PersonaPackError,
  type ContextualRule,
  type PersonaManifest,
} from "../../core/domain/persona-pack.js";
import type { LoadedPersonaPack } from "../../core/services/variant-resolver.js";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_PACK_BYTES = 2 * 1024 * 1024;
export const MAX_PACK_FILES = 64;
export const MANIFEST_FILENAME = "persona.json";

export interface LoadPackOptions {
  /** Absolute directory of one pack (the directory holding persona.json). */
  readonly packDir: string;
}

function refuse(message: string): never {
  throw new PersonaPackError("path_invalid", message);
}

/**
 * Enumerate the pack: regular files only, bounded, pack-relative POSIX paths.
 */
async function enumerate(packDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  let totalBytes = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 6) refuse(`the pack nests too deeply at ${prefix || "."}`);
    const entries = await readdir(dir);
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      // lstat: a symlink is seen AS a symlink, never followed.
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        refuse(`the pack contains a symlink at ${relative}; symlinks are refused`);
      }
      if (info.isDirectory()) {
        if (entry.startsWith(".")) refuse(`hidden directory ${relative} is refused`);
        await walk(full, relative, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        refuse(`${relative} is not a regular file; device and special files are refused`);
      }
      if (entry.startsWith(".")) refuse(`hidden file ${relative} is refused`);
      if (info.size > MAX_FILE_BYTES) {
        refuse(`${relative} exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_PACK_BYTES) {
        refuse(`the pack exceeds the ${MAX_PACK_BYTES}-byte total limit`);
      }
      files.push(relative);
      if (files.length > MAX_PACK_FILES) {
        refuse(`the pack contains more than ${MAX_PACK_FILES} files`);
      }
    }
  }

  await walk(packDir, "", 0);
  return files;
}

/** UTF-8 text with no NUL: the only content shape a pack may carry. */
async function readTextEntry(packDir: string, relative: string): Promise<string> {
  const bytes = await readFile(join(packDir, relative));
  if (bytes.includes(0)) {
    refuse(`${relative} contains binary content; pack entries are text`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse(`${relative} is not valid UTF-8`);
  }
}

export async function loadPersonaPack(options: LoadPackOptions): Promise<LoadedPersonaPack> {
  const { packDir } = options;
  const files = await enumerate(packDir);

  if (!files.includes(MANIFEST_FILENAME)) {
    refuse(`the pack has no ${MANIFEST_FILENAME}`);
  }

  const manifestText = await readTextEntry(packDir, MANIFEST_FILENAME);
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch {
    throw new PersonaPackError("field_invalid", `${MANIFEST_FILENAME} is not valid JSON`);
  }

  const claimable = files.filter((f) => f !== MANIFEST_FILENAME);
  const manifest: PersonaManifest = parsePersonaManifest(document, claimable);

  // Every present file must be claimed. A file the manifest does not name is
  // content nobody reviewed riding along with content somebody did.
  const claimed = new Set<string>([
    ...manifest.base.map((b) => b.path),
    ...manifest.variants.map((v) => v.path),
    ...manifest.overlays.map((o) => o.path),
    ...(manifest.rulesPath === undefined ? [] : [manifest.rulesPath]),
  ]);
  for (const file of claimable) {
    if (!claimed.has(file)) {
      refuse(`${file} is present in the pack but not named by the manifest`);
    }
  }

  const blocks = new Map<string, string>();
  for (const path of claimed) {
    blocks.set(path, await readTextEntry(packDir, path));
  }

  let rules: readonly ContextualRule[] = [];
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
