/**
 * System-prompt assembly.
 *
 * Core consumes a `PromptBundle` and nothing more. It does not know, and must
 * never learn, whether that bundle came from a directory, an editor, an
 * imported profile, or a synced folder.
 */

import type { PromptBundle } from "../domain/types.js";

/**
 * Join a bundle into one system-prompt string.
 *
 * Sections are separated by a blank line and nothing else. There is no
 * delimiter protocol, no banner, and no injected heading: a marker the model
 * has not been taught to read is noise, and one it HAS been taught to read is
 * a protocol that belongs with whatever defines it, not here.
 *
 * Pure - it depends only on its argument.
 */
export function assembleSystemPrompt(bundle: PromptBundle): string {
  return bundle.sections
    .map((section) => section.content.replace(/\n+$/, ""))
    .join("\n\n");
}
