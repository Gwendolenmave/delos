/**
 * Reply sanitizer.
 *
 * Scope, deliberately narrow: remove characters that are unsafe to hand to a
 * terminal or to store, and nothing else.
 *
 * This module does NOT improve prose. It does not soften tone, delete
 * apologies, add punctuation, adjust length, strip tags, or decide what an
 * answer should look like. Those are the user's business and the persona's,
 * and a core module that quietly rewrites model output makes both
 * unauditable - you can no longer tell what the model actually said.
 *
 * It also does not know about any provider's quirks. If one model emits a
 * reasoning container or a role prefix, that is that adapter's problem to
 * declare and handle, or a configurable transform later. Teaching the core
 * sanitizer one vendor's output format makes every future provider inherit a
 * rule written for a model they are not.
 *
 * Pure. No provider, CLI, persona or configuration dependency.
 */

export type ReplySanitizationFailure = "empty_input" | "empty_after_sanitization";

export type ReplySanitizationResult =
  | { ok: true; text: string }
  | { ok: false; reason: ReplySanitizationFailure };

/**
 * Control strings: OSC, DCS, SOS, PM and APC.
 *
 * Each is an introducer, an arbitrary payload, and a terminator. They set
 * terminal titles, emit hyperlinks, program function keys, and on some
 * terminals can write the clipboard - which is why this function exists.
 *
 * **The payload must be removed with the introducer.** Stripping only the
 * introducer and terminator leaves the payload behind as visible garbage,
 * which is worse than leaving the sequence intact: the user sees noise and
 * cannot tell it was a control sequence.
 *
 * Both encodings are covered. A 7-bit introducer is ESC plus a final byte;
 * the 8-bit C1 equivalents are single bytes:
 *   DCS ESC P / U+0090   OSC ESC ] / U+009D   SOS ESC X / U+0098
 *   PM  ESC ^ / U+009E   APC ESC _ / U+009F
 * Terminated by ST (ESC \ or U+009C), by BEL for OSC, or unterminated - in
 * which case the rest of the input goes with it, because a truncated control
 * string must not deliver its payload as text.
 */
const CONTROL_STRING =
  /(?:\x1B[P\]X^_]|[\x90\x9D\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C|\x07|$)/g;

/**
 * CSI: colour, cursor motion, screen clears. 7-bit `ESC [` and the 8-bit C1
 * form U+009B are the same sequence written two ways, and a sanitizer that
 * knew only the first would let the second through with its parameters
 * visible as `31m`.
 */
const CSI_SEQUENCE = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g;

/** Remaining two- and three-character escapes, and any stray C1 control. */
const OTHER_ESCAPE = /\x1B[@-Z\\-_]|\x1B[ -/]*[0-~]|[\x80-\x9F]/g;

/**
 * C0 controls and DEL, EXCEPT tab and newline.
 *
 * Tab and newline are ordinary text: they carry indentation inside code blocks
 * and paragraph structure everywhere. Removing them would corrupt exactly the
 * content this function is supposed to leave alone. Carriage return is not
 * listed because newline normalisation below has already consumed it.
 */
const DISALLOWED_C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;


/**
 * Sanitise one reply.
 *
 * Line endings: **CRLF and lone CR are normalised to LF.** This is a contract,
 * not an accident of the platform the code happens to run on. Replies are
 * stored, compared and hashed; if identical text produced different bytes on
 * different operating systems, none of those operations would be reliable.
 *
 * Everything else passes through untouched: Unicode of any script, emoji,
 * combining marks, non-BMP characters, Markdown, links, lists, fenced code and
 * its indentation, HTML and XML, and any leading or trailing whitespace the
 * model chose to emit. The result is **not trimmed** - trimming would alter
 * code blocks and deliberate spacing, and there is no general reason to.
 */
export function sanitizeReplyText(input: string): ReplySanitizationResult {
  if (input.length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  let text = input;

  // Order matters. Control strings go first, whole: if a later pass removed
  // their introducer, the payload would survive as visible text. CSI next,
  // then whatever single escapes and stray C1 controls remain.
  text = text.replace(CONTROL_STRING, "");
  text = text.replace(CSI_SEQUENCE, "");
  text = text.replace(OTHER_ESCAPE, "");

  // Normalise line endings before the control pass, so CR is handled here as
  // structure rather than deleted there as a control character.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  text = text.replace(DISALLOWED_C0, "");

  // Visibility is CHECKED by trimming; the returned text is not trimmed.
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty_after_sanitization" };
  }

  return { ok: true, text };
}
