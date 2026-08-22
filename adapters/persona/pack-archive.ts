/**
 * Persona-pack ZIP support, implemented directly over node:zlib.
 *
 * Hand-rolled rather than a dependency, for two owned reasons: export must be
 * DETERMINISTIC (same pack, same bytes - libraries stamp timestamps unless
 * fought), and import must be PARANOID in exactly our terms (entry-name
 * validation before any byte is inflated, symlink external-attribute
 * detection, bomb caps on declared AND actual inflated sizes). The subset of
 * the format we accept is small and stated: stored or deflated entries, no
 * encryption, no spanning, no zip64, no data descriptors on read.
 *
 * The reader walks the CENTRAL DIRECTORY, not local headers: the central
 * directory is what an extracting tool trusts, so it is what validation must
 * trust too - a mismatch between the two is itself a refusal.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

import { PersonaPackError, validatePackPath } from "../../core/domain/persona-pack.js";
import { MAX_FILE_BYTES, MAX_PACK_BYTES, MAX_PACK_FILES } from "./filesystem-pack-loader.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** CRC-32, the ZIP polynomial. Small table, computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function refuse(message: string): never {
  throw new PersonaPackError("path_invalid", message);
}

// ---------------------------------------------------------------------------
// Writer: deterministic, store-only
// ---------------------------------------------------------------------------

/**
 * Build a deterministic ZIP: entries sorted by name, stored uncompressed,
 * every timestamp fixed to the DOS epoch (1980-01-01), no extra fields, no
 * comments, external attributes zero. Same entries, same bytes, every time.
 */
export function writePackZip(entries: ReadonlyMap<string, string>): Buffer {
  const names = [...entries.keys()].sort();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const data = Buffer.from(entries.get(name) ?? "", "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // DOS time: 00:00:00
    local.writeUInt16LE(0x21, 12); // DOS date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra len, comment len, disk, internal attrs, external attrs: all zero
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---------------------------------------------------------------------------
// Reader: paranoid
// ---------------------------------------------------------------------------

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc: number;
  readonly localOffset: number;
  readonly externalAttrs: number;
}

function readCentralDirectory(zip: Buffer): readonly CentralEntry[] {
  // Find EOCD from the end; refuse comments longer than a small bound rather
  // than scanning unbounded attacker-supplied data.
  const scanFrom = Math.max(0, zip.length - 22 - 1024);
  let eocdAt = -1;
  for (let i = zip.length - 22; i >= scanFrom; i--) {
    if (zip.readUInt32LE(i) === SIG_EOCD) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt === -1) refuse("not a ZIP archive (no end-of-central-directory)");
  const count = zip.readUInt16LE(eocdAt + 10);
  const centralSize = zip.readUInt32LE(eocdAt + 12);
  const centralStart = zip.readUInt32LE(eocdAt + 16);
  if (count > MAX_PACK_FILES) refuse(`the archive lists more than ${MAX_PACK_FILES} entries`);
  if (centralStart + centralSize > zip.length) refuse("central directory overruns the archive");

  const entries: CentralEntry[] = [];
  let at = centralStart;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== SIG_CENTRAL) refuse("malformed central directory");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressedSize = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const externalAttrs = zip.readUInt32LE(at + 38);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, crc, localOffset, externalAttrs });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read and validate a persona-pack ZIP into name -> content.
 *
 * Validation order matters: names and attributes are judged BEFORE any byte
 * of content is inflated, so a hostile archive is rejected on its shape.
 */
/**
 * The generic text-ZIP reader every archive feature shares. The persona
 * reader and the backup reader differ ONLY in their path grammar and
 * size caps - the paranoia (symlink attributes, bomb caps on declared and
 * actual sizes, checksum, UTF-8, duplicate names) is common and lives here
 * exactly once.
 */
export interface TextZipReadOptions {
  readonly maxArchiveBytes: number;
  readonly maxFileBytes: number;
  /** Throws (via its own error type) for a path the caller's grammar refuses. */
  readonly validateEntryPath: (name: string) => void;
  /** The caller's refusal - so backup failures are not persona errors. */
  readonly refuseWith: (message: string) => never;
}

export function readTextZip(zip: Buffer, options: TextZipReadOptions): ReadonlyMap<string, string> {
  // The explicit annotation is what lets the compiler treat a deny() call as
  // terminating for definite-assignment analysis.
  const deny: (message: string) => never = options.refuseWith;
  if (zip.length > options.maxArchiveBytes) {
    deny(`the archive exceeds the ${options.maxArchiveBytes}-byte limit`);
  }
  const entries = readCentralDirectory(zip);
  const out = new Map<string, string>();
  let totalInflated = 0;

  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      // Directory entries carry no content; they are implied by file paths.
      continue;
    }
    // Path discipline first, before any byte is inflated.
    options.validateEntryPath(entry.name);

    // A symlink in a ZIP is a Unix file mode in the external attributes'
    // high bits: S_IFLNK = 0xA000.
    const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      deny(`zip entry ${entry.name} is a symlink; symlinks are refused`);
    }

    if (entry.method !== 0 && entry.method !== 8) {
      deny(`zip entry ${entry.name} uses an unsupported compression method`);
    }
    if (entry.uncompressedSize > options.maxFileBytes) {
      deny(`zip entry ${entry.name} declares more than ${options.maxFileBytes} bytes`);
    }
    totalInflated += entry.uncompressedSize;
    if (totalInflated > options.maxArchiveBytes) {
      deny(`the archive inflates past the ${options.maxArchiveBytes}-byte limit`);
    }

    // Local header: only to find the data; sizes come from the central record.
    if (zip.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
      deny(`zip entry ${entry.name} has a malformed local header`);
    }
    const lNameLen = zip.readUInt16LE(entry.localOffset + 26);
    const lExtraLen = zip.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + lNameLen + lExtraLen;
    const compressed = zip.subarray(dataStart, dataStart + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) {
      deny(`zip entry ${entry.name} is truncated`);
    }

    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        // maxOutputLength: the declared size is the promise; inflating past it
        // is the bomb, and zlib enforces the cap during inflation.
        data = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
      } catch {
        deny(`zip entry ${entry.name} does not inflate cleanly within its declared size`);
      }
    }
    if (data.length !== entry.uncompressedSize) {
      deny(`zip entry ${entry.name} inflated to a different size than declared`);
    }
    if (crc32(data) !== entry.crc) {
      deny(`zip entry ${entry.name} fails its checksum`);
    }
    if (data.includes(0)) {
      deny(`zip entry ${entry.name} contains binary content; pack entries are text`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      deny(`zip entry ${entry.name} is not valid UTF-8`);
    }
    if (out.has(entry.name)) {
      deny(`zip entry ${entry.name} appears twice`);
    }
    out.set(entry.name, text);
  }

  return out;
}

export function readPackZip(zip: Buffer): ReadonlyMap<string, string> {
  const out = readTextZip(zip, {
    maxArchiveBytes: MAX_PACK_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    // The same rules as a directory pack, so a ZIP cannot express anything
    // a directory could not; the manifest name is allowed as-is.
    validateEntryPath: (name) => {
      if (name !== "persona.json") validatePackPath(name, `zip entry ${name}`);
    },
    refuseWith: refuse,
  });
  if (!out.has("persona.json")) refuse("the archive has no persona.json");
  return out;
}

/** Exported for tests that need to build hostile archives. */
export const ZIP_INTERNALS = { deflateRawSync };
