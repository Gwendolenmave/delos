/**
 * The attachment boundary (13.1): what may enter Delos as media, and under
 * which rules. Ports only - adapters do the IO.
 *
 * Ground rules, enforced at the intake:
 *
 * - Filenames from outside are DATA: they are reduced to a safe basename
 *   with a vetted extension before touching the filesystem.
 * - Size is enforced WHILE STREAMING, never after the fact: a download that
 *   crosses the cap is aborted and its partial file deleted.
 * - Downloads are atomic: bytes land in a `.part` staging name and are
 *   renamed into place only when complete; a crash leaves only staging
 *   litter, which the cleanup sweep removes by age.
 * - No external STT service is required or contacted by default. Speech-to-
 *   text is a PLUGGABLE local adapter (typically an external command the
 *   user installed); absent an adapter, voice input is truthfully
 *   unsupported rather than silently dropped.
 * - Image input requires EVIDENCED provider capability. No provider in
 *   v0.1 evidences it, so image attachments receive a truthful
 *   unsupported-capability response.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Extensions the attachment intake will accept, lowercase. */
export const AUDIO_EXTENSIONS = ["ogg", "oga", "opus", "mp3", "m4a", "wav", "webm"] as const;

export interface SttResult {
  readonly ok: boolean;
  /** Transcript on success; a safe, redacted explanation otherwise. */
  readonly text: string;
}

/** A pluggable local speech-to-text adapter. */
export interface SttAdapter {
  readonly name: string;
  transcribe(audioPath: string, options: { timeoutMs: number }): Promise<SttResult>;
}

/**
 * Reduce an outside filename to a safe basename. Path separators, dot
 * segments, control characters and exotic punctuation are gone; the
 * extension must come from the allowlist or the fallback is used.
 */
export function safeAttachmentName(original: string, fallbackExt: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  const stemRaw = lastDot > 0 ? base.slice(0, lastDot) : base;
  const extRaw = lastDot > 0 ? base.slice(lastDot + 1).toLowerCase() : "";
  const stem = stemRaw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  const ext = (AUDIO_EXTENSIONS as readonly string[]).includes(extRaw) ? extRaw : fallbackExt;
  return `${stem.length === 0 ? "attachment" : stem}.${ext}`;
}
