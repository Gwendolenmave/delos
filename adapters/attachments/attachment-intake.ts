/**
 * Attachment intake: streamed size enforcement, atomic staging, abandoned-
 * temp cleanup. See core/ports/attachment.ts for the rules.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { safeAttachmentName } from "../../core/ports/attachment.js";

export class AttachmentError extends Error {
  constructor(
    readonly code: "too_large" | "io_failed" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface StagedAttachment {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const STAGING = ".staging";

/**
 * Stream bytes into the attachment directory. The cap is enforced PER
 * CHUNK while streaming; crossing it aborts the download and removes the
 * partial file. Completion renames atomically from the staging name.
 */
export async function stageAttachment(options: {
  readonly source: AsyncIterable<Uint8Array>;
  readonly declaredName: string;
  readonly directory: string;
  readonly maxBytes: number;
}): Promise<StagedAttachment> {
  const stagingDir = join(options.directory, STAGING);
  await mkdir(stagingDir, { recursive: true });
  const partPath = join(stagingDir, `${randomBytes(8).toString("hex")}.part`);

  let bytes = 0;
  const hash = createHash("sha256");
  try {
    const sink = createWriteStream(partPath, { flags: "wx" });
    for await (const chunk of options.source) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        sink.destroy();
        throw new AttachmentError(
          "too_large",
          `The attachment exceeded the ${options.maxBytes}-byte cap and was discarded.`,
        );
      }
      hash.update(chunk);
      if (!sink.write(chunk)) {
        await new Promise<void>((resolve) => sink.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => resolve());
      sink.once("error", reject);
    });
  } catch (error) {
    await rm(partPath, { force: true });
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("io_failed", "The attachment could not be stored.");
  }

  if (bytes === 0) {
    await rm(partPath, { force: true });
    throw new AttachmentError("empty", "The attachment carried no bytes.");
  }

  const digest = hash.digest("hex");
  const safeName = safeAttachmentName(options.declaredName, "ogg");
  const finalPath = join(options.directory, `${digest.slice(0, 8)}-${safeName}`);
  await rename(partPath, finalPath);
  return { path: finalPath, bytes, sha256: digest };
}

/** Remove staging litter older than the age cutoff. Returns removals. */
export async function cleanupAbandoned(
  directory: string,
  olderThanMs: number,
  nowMs: number,
): Promise<number> {
  const stagingDir = join(directory, STAGING);
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch {
    return 0; // no staging directory: nothing abandoned
  }
  for (const entry of entries) {
    if (!entry.endsWith(".part")) continue;
    const full = join(stagingDir, entry);
    try {
      const info = await stat(full);
      if (nowMs - info.mtimeMs > olderThanMs) {
        await rm(full, { force: true });
        removed++;
      }
    } catch {
      // Raced with another cleanup: fine.
    }
  }
  return removed;
}
